/**
 * web/src/screens/Topology.tsx — the estate-level cross-plane topology.
 *
 * One graph over every plane's REPORTED neighbour facts (shared/topologyGraph.ts
 * builds it; GET /api/topology serves it). A site is a collapse/expand grouping:
 * collapsed, one compact card per site; expanded, its devices open inside the
 * card and its internal links list underneath. Cross-site reports are a separate
 * readable list, never an overlapping line layer. Neighbours that resolve to no
 * inventory row sit in the "filed nowhere" strip as ghosts — reported, never
 * promoted.
 *
 * The visual language is compact responsive cards and plain connection rows:
 * no absolute positioning, no SVG line routing, and no relationship labels
 * hidden behind cards when a site grows.
 *
 * Edge labels carry the provenance the graph merged: ports and speed when
 * reported, the evidence words (LLDP/CDP/VSF/recorded uplink), every source
 * plane's badge, and 'stale' when no fresh source vouches for the link. A link
 * two planes report reads as one line with two badges, not two guesses.
 *
 * Focus mode is the site diagram's idiom: shift+click any card (or plain-click
 * a card with no other action, like a ghost) to isolate it with its 1-hop
 * neighbours — everything else dims, cards and edges alike. While a focus is
 * active every card click moves it (navigation is suspended, never triggered);
 * the exit chip, Esc or a click on the canvas background restores the graph.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { countOf, hhmmLocal as hhmm } from '@hpe/shared';
import type {
  DeviceType,
  StatDef,
  Tone,
  TopologyGraph,
  TopologyGraphEdge,
  TopologyGraphNode,
  TopologyGraphSite,
} from '@hpe/shared';
import {
  PageSkeleton, Alert, Badge, Button, EmptyState, useToast } from '../nightdesk';
import { getTopology } from '../api/client';
import type { TopologyData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { deviceDetailPath } from '../app/nav';
import { ScreenHeader } from './ScreenHeader';
import { exportTableCsv } from '../lib/csv';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { Topology3DCanvas } from './Topology3DCanvas';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { DeviceTypeBadge } from '../components/DeviceTypeBadge';

export const UNFILED_KEY = '__filed-nowhere__';

// ---------------------------------------------------------------------------
// Wording — edge labels, ghost subs, stats
// ---------------------------------------------------------------------------

/** Status words that need no text (the site diagram's QUIET_STATES rule). */
const QUIET_STATES = new Set(['up', 'ok', 'online']);

function stateWorthDrawing(state: string | null): string | null {
  if (state === null) return null;
  const text = state.trim();
  return text === '' || QUIET_STATES.has(text.toLowerCase()) ? null : text;
}

const DOT: Partial<Record<Tone, string>> = {
  success: 'var(--nd-success)',
  warning: 'var(--nd-warning)',
  danger: 'var(--nd-danger)',
  neutral: 'var(--nd-border-strong)',
  accent: 'var(--nd-accent)',
  info: 'var(--nd-info, var(--nd-border-strong))',
};

function formatBps(bps: number | null): string | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) return null;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`;
  return `${Math.round(bps)} bps`;
}

/** The sources vouching for an edge, deduped in report order; a null plane is
 *  the portal's own wiring records and is worded as that, never as a plane. */
export function edgeSourceWords(edge: TopologyGraphEdge): string[] {
  const words: string[] = [];
  for (const p of edge.provenance) {
    const word = p.plane ?? 'portal records';
    if (!words.includes(word)) words.push(word);
  }
  return words;
}

/**
 * One edge, worded: port-to-port, speed when reported, the evidence words,
 * the sources, and staleness. Only the exceptions say anything — a fresh,
 * single-source, full-speed link is the ordinary case.
 */
export function topologyEdgeLabel(edge: TopologyGraphEdge, nodeById: Map<string, TopologyGraphNode>): string {
  const from = nodeById.get(edge.from);
  const to = nodeById.get(edge.to);
  const side = (node: TopologyGraphNode | undefined, port: string | null): string =>
    [node?.name ?? '?', port].filter(Boolean).join(' ');
  return [
    `${side(from, edge.fromPort)} ↔ ${side(to, edge.toPort)}`,
    formatBps(edge.speedBps),
    edge.protocols.join(' + '),
    edgeSourceWords(edge).join(' + '),
    edge.stale ? 'stale' : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/** A ghost's evidence line: who reported it, by which words. */
function ghostSub(node: TopologyGraphNode, edges: readonly TopologyGraphEdge[]): string {
  const protocols: string[] = [];
  for (const edge of edges) {
    if (edge.from !== node.id && edge.to !== node.id) continue;
    for (const word of edge.protocols) if (!protocols.includes(word)) protocols.push(word);
  }
  const reportedBy = node.planes.length > 0 ? node.planes.join(' + ') : 'portal records';
  return `reported by ${reportedBy}${protocols.length > 0 ? ` · ${protocols.join(' + ')}` : ''}`;
}

// ---------------------------------------------------------------------------
// The diagram
// ---------------------------------------------------------------------------

interface Focus {
  kind: 'site' | 'node';
  id: string;
}

function SiteCard({
  site,
  nodes,
  edges,
  expanded,
  nodeById,
  dimmed,
  focused,
  focusActive,
  focusNodeId,
  litNodes,
  onToggle,
  onOpenSite,
  onOpenDevice,
  onFocus,
}: {
  site: TopologyGraphSite;
  nodes: TopologyGraphNode[];
  edges: TopologyGraphEdge[];
  expanded: boolean;
  nodeById: Map<string, TopologyGraphNode>;
  dimmed: boolean;
  focused: boolean;
  focusActive: boolean;
  /** The focused node's id, and the lit set — chips dim and ring individually. */
  focusNodeId: string | null;
  litNodes: ReadonlySet<string> | null;
  onToggle: (siteId: string) => void;
  onOpenSite: (siteId: string) => void;
  onOpenDevice: (node: TopologyGraphNode) => void;
  onFocus: (focus: Focus) => void;
}) {
  const internal = edges.filter((e) => {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    return a?.siteId === site.siteId && b?.siteId === site.siteId;
  });
  const summary =
    site.nodeCount === 0
      ? 'no devices in the merged inventory'
      : `${countOf(site.nodeCount, 'device')} · ${countOf(internal.length, 'link')} inside`;
  const handleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (event.shiftKey || focusActive) {
      onFocus({ kind: 'site', id: site.siteId });
      return;
    }
    onToggle(site.siteId);
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: expanded ? 280 : 84,
        background: 'var(--nd-bg-raised)',
        border: `1px solid ${focused ? 'var(--nd-accent)' : 'var(--nd-border-subtle)'}`,
        borderRadius: 2,
        opacity: dimmed ? 0.25 : 1,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        className="nt-rowlink"
        aria-label={
          focusActive
            ? `Focus ${site.name}`
            : expanded
              ? `Collapse ${site.name}`
              : `Expand ${site.name}`
        }
        aria-expanded={expanded}
        onClick={handleClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '10px 12px',
          background: 'transparent',
          border: 'none',
          borderBottom: expanded ? '1px solid var(--nd-border-subtle)' : 'none',
          cursor: 'pointer',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        <span
          aria-hidden
          className="nt-topo-dot" style={{ background: DOT[site.tone] ?? 'var(--nd-border-strong)' }}
        />
        <span className="nt-stack nt-gap-2 nt-flex-1">
          <span
            className="nt-topo-title nt-ellipsis"
          >
            {site.name}
          </span>
          <span
            className="nt-hint-muted" style={{ whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis' }}
          >
            {summary}
            {site.externalEdges > 0 ? ` · ${countOf(site.externalEdges, 'inter-site link')}` : ''}
            {expanded ? ' · collapse' : ' · expand'}
          </span>
        </span>
        <span className="nt-chip-end">
          {site.planes.map((plane) => (
            <Badge key={plane} tone="neutral">
              {plane}
            </Badge>
          ))}
        </span>
      </button>
      {expanded ? (
        <div className="nt-topo-card__body">
          {site.nodeCount === 0 ? (
            <span className="nt-hint-muted nt-lh-16">
              No device in the merged inventory is filed at this site — the card stays so the estate picture is
              complete, not because a graph reaches here.
            </span>
          ) : (
            <div className="nt-wrap-6">
              {nodes.map((node) => (
                <DeviceChip
                  key={node.id}
                  node={node}
                  dimmed={litNodes !== null && !litNodes.has(node.id)}
                  focused={focusNodeId === node.id}
                  focusActive={focusActive}
                  onOpen={onOpenDevice}
                  onFocus={onFocus}
                />
              ))}
            </div>
          )}
          {internal.length > 0 ? (
            <div className="nt-stack nt-gap-2">
              <span
                className="nt-mono-label"
              >
                REPORTED LINKS INSIDE
              </span>
              {internal.map((edge) => (
                <span
                  key={edge.id}
                  className="nt-hint-muted nt-ellipsis"
                  style={{ color: edge.stale ? 'var(--nd-warning)' : 'var(--nd-text-muted)' }}
                >
                  {topologyEdgeLabel(edge, nodeById)}
                </span>
              ))}
            </div>
          ) : null}
          {/* The site's own page draws the full per-site graph; offer it rather
              than re-drawing a second layered diagram inside this card. */}
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onOpenSite(site.siteId);
              }}
            >
              Open site
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DeviceChip({
  node,
  dimmed,
  focused,
  focusActive,
  onOpen,
  onFocus,
}: {
  node: TopologyGraphNode;
  dimmed: boolean;
  focused: boolean;
  focusActive: boolean;
  onOpen: (node: TopologyGraphNode) => void;
  onFocus: (focus: Focus) => void;
}) {
  const shownState = stateWorthDrawing(node.state);
  const knownTypes = new Set(['switch', 'ap', 'gateway', 'controller', 'sensor', 'policy']);
  const deviceType =
    node.type && knownTypes.has(node.type) ? (node.type as DeviceType) : null;
  const handleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (event.shiftKey || focusActive || node.ghost) {
      onFocus({ kind: 'node', id: node.id });
      return;
    }
    onOpen(node);
  };
  return (
    <button
      type="button"
      className="nt-rowlink"
      aria-label={
        (focusActive || node.ghost ? `Focus ${node.name}` : `Open device ${node.name}`) +
        (shownState !== null ? `, ${shownState}` : '') +
        (node.ghost ? ' — reported, not in the inventory' : '')
      }
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 9px',
        background: 'var(--nd-bg-surface)',
        border: `1px ${node.ghost ? 'dashed' : 'solid'} ${
          focused ? 'var(--nd-accent)' : node.tone === 'danger' ? 'var(--nd-danger)' : 'var(--nd-border-subtle)'
        }`,
        borderRadius: 2,
        cursor: 'pointer',
        font: 'inherit',
        opacity: dimmed ? 0.25 : 1,
        maxWidth: '100%',
      }}
    >
      <span
        aria-hidden
        className="nt-topo-dot nt-topo-dot--sm" style={{ background: DOT[node.tone] ?? 'var(--nd-border-strong)' }}
      />
      <span className="nt-stack nt-gap-0" style={{ minWidth: 0, textAlign: "left" }}>
        <span
          className="nt-topo-title nt-ellipsis nt-mono-11"
        >
          {node.name}
        </span>
        <span
          className="nt-row nt-mono-label nt-ellipsis"
          style={{
            gap: 5,
            color: shownState !== null && node.tone === 'danger' ? 'var(--nd-danger)' : 'var(--nd-text-muted)',
          }}
        >
          {deviceType ? <DeviceTypeBadge type={deviceType} /> : null}
          <span>
            {[!deviceType ? node.type : null, shownState].filter(Boolean).join(' · ') ||
              (node.ghost ? 'reported neighbour' : '')}
          </span>
        </span>
      </span>
    </button>
  );
}

export function TopologyGraphView({
  graph,
  onOpenSite,
  onOpenDevice,
}: {
  graph: TopologyGraph;
  onOpenSite: (siteId: string) => void;
  onOpenDevice: (node: TopologyGraphNode) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<Focus | null>(null);

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  // Nodes filed nowhere the site list names: ghosts first (reported, never
  // inventoried), then managed rows under bookkeeping ids.
  const unfiled = useMemo(
    () => graph.nodes.filter((n) => n.siteId === null || !graph.sites.some((s) => s.siteId === n.siteId)),
    [graph],
  );
  const nodesBySite = useMemo(() => {
    const map = new Map<string, TopologyGraphNode[]>();
    for (const site of graph.sites) {
      map.set(
        site.siteId,
        graph.nodes.filter((n) => !n.ghost && n.siteId === site.siteId),
      );
    }
    return map;
  }, [graph]);

  const siteIds = new Set(graph.sites.map((site) => site.siteId));
  const cellKeyFor = (node: TopologyGraphNode): string =>
    node.siteId !== null && siteIds.has(node.siteId) ? node.siteId : UNFILED_KEY;

  // 1-hop adjacency over the graph's own node ids.
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      const set = map.get(a) ?? new Set<string>();
      set.add(b);
      map.set(a, set);
    };
    for (const edge of graph.edges) {
      link(edge.from, edge.to);
      link(edge.to, edge.from);
    }
    return map;
  }, [graph.edges]);

  /* What stays lit. A focused SITE lights its nodes and every node they touch;
     a focused NODE lights its 1-hop neighbours. Either way the cells holding a
     lit node stay lit, so the hairlines keep both ends visible. A focus target
     a refresh dropped reads as no focus rather than dimming everything.
     Computed inline — the graph is small and this only walks 1-hop sets. */
  const lit = (() => {
    if (focus === null) return null;
    const litNodes = new Set<string>();
    if (focus.kind === 'site') {
      const members = graph.nodes.filter((n) => n.siteId === focus.id);
      if (members.length === 0 && !graph.sites.some((s) => s.siteId === focus.id)) return null;
      for (const member of members) {
        litNodes.add(member.id);
        for (const next of adjacency.get(member.id) ?? []) litNodes.add(next);
      }
    } else {
      if (!nodeById.has(focus.id)) return null;
      litNodes.add(focus.id);
      for (const next of adjacency.get(focus.id) ?? []) litNodes.add(next);
    }
    const litCells = new Set<string>();
    for (const id of litNodes) {
      const node = nodeById.get(id);
      if (node) litCells.add(cellKeyFor(node));
    }
    if (focus.kind === 'site') litCells.add(focus.id);
    const label =
      focus.kind === 'site'
        ? (graph.sites.find((s) => s.siteId === focus.id)?.name ?? focus.id)
        : (nodeById.get(focus.id)?.name ?? focus.id);
    return { nodes: litNodes, cells: litCells, label, focusNodeId: focus.kind === 'node' ? focus.id : null };
  })();

  // Esc leaves focus mode; the listener exists only while there is one to leave.
  useEffect(() => {
    if (focus === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocus(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focus]);

  const toggle = (siteId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(siteId)) next.delete(siteId);
      else next.add(siteId);
      return next;
    });

  // Cross-site links are deliberately a readable list instead of a line layer.
  // The former canvas routed lines through unrelated cards as the grid changed.
  const crossing = graph.edges.filter((edge) => {
    const a = nodeById.get(edge.from);
    const b = nodeById.get(edge.to);
    return a !== undefined && b !== undefined && cellKeyFor(a) !== cellKeyFor(b);
  });
  const edgeIsLit = (edge: TopologyGraphEdge) =>
    lit === null ||
    (lit.focusNodeId !== null
      ? edge.from === lit.focusNodeId || edge.to === lit.focusNodeId
      : lit.nodes.has(edge.from) || lit.nodes.has(edge.to));

  return (
    <div
      className="nt-stack nt-gap-8"
      onClick={() => {
        if (focus !== null) setFocus(null);
      }}
    >
      {lit !== null && focus !== null ? (
        <div className="nt-filter-bar nt-gap-10">
          <Badge tone="accent">focus</Badge>
          <span
            className="nt-hint-muted nt-flex-1"
          >
            {`${lit.label} · ${countOf(lit.nodes.size, 'node')} in view · click another card to move the focus · Esc or click the background to leave`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              setFocus(null);
            }}
          >
            Exit focus
          </Button>
        </div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, alignItems: 'start' }}>
        {graph.sites.map((site) => {
          return (
            <SiteCard
              key={site.siteId}
              site={site}
              nodes={nodesBySite.get(site.siteId) ?? []}
              edges={graph.edges}
              expanded={expanded.has(site.siteId)}
              nodeById={nodeById}
              dimmed={lit !== null && !lit.cells.has(site.siteId)}
              focused={focus?.kind === 'site' && focus.id === site.siteId}
              focusActive={lit !== null}
              focusNodeId={lit?.focusNodeId ?? null}
              litNodes={lit?.nodes ?? null}
              onToggle={toggle}
              onOpenSite={onOpenSite}
              onOpenDevice={onOpenDevice}
              onFocus={setFocus}
            />
          );
        })}

        {crossing.length > 0 ? (
          <section
            aria-label="Site connections"
            style={{
              gridColumn: '1 / -1',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              background: 'var(--nd-bg-raised)',
              border: '1px solid var(--nd-border-subtle)',
              borderRadius: 2,
              padding: '10px 12px',
            }}
          >
            <span className="nt-mono-label">
              SITE CONNECTIONS — reported links between sites or unfiled neighbours
            </span>
            {crossing.map((edge) => (
              <span
                key={edge.id}
                className="nt-hint-muted"
                style={{
                  color: edge.stale ? 'var(--nd-warning)' : 'var(--nd-text-muted)',
                  opacity: edgeIsLit(edge) ? 1 : 0.2,
                  overflowWrap: 'anywhere',
                }}
              >
                {topologyEdgeLabel(edge, nodeById)}
              </span>
            ))}
          </section>
        ) : null}

        {unfiled.length > 0 ? (
          <section
            aria-label="Reported neighbours without inventory"
            style={{
              gridColumn: '1 / -1',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'var(--nd-bg-raised)',
              border: '1px dashed var(--nd-border-subtle)',
              borderRadius: 2,
              padding: '10px 12px',
              opacity: lit !== null && !lit.cells.has(UNFILED_KEY) ? 0.25 : 1,
            }}
          >
            <span
              className="nt-mono-label"
            >
              REPORTED, FILED NOWHERE — neighbours with no inventory row, and devices with no physical site
            </span>
            <div className="nt-wrap-6">
              {unfiled.map((node) => (
                <DeviceChip
                  key={node.id}
                  node={node}
                  dimmed={lit !== null && !lit.nodes.has(node.id)}
                  focused={lit?.focusNodeId === node.id}
                  focusActive={lit !== null}
                  onOpen={onOpenDevice}
                  onFocus={setFocus}
                />
              ))}
            </div>
            <span className="nt-hint-muted">
              {unfiled
                .filter((n) => n.ghost)
                .map((n) => `${n.name} — ${ghostSub(n, graph.edges)}`)
                .join(' · ')}
            </span>
          </section>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

function topologyStats(graph: TopologyGraph, dataSource: string): StatDef[] {
  const devices = graph.nodes.filter((n) => !n.ghost);
  const ghosts = graph.nodes.filter((n) => n.ghost);
  const crossSite = graph.edges.filter((e) => e.crossSite);
  const stale = graph.edges.filter((e) => e.stale);
  return [
    {
      label: 'Devices',
      value: String(devices.length),
      delta: dataSource === 'live' ? 'in the merged inventory' : 'in the demo estate',
      tone: 'neutral',
    },
    {
      label: 'Reported links',
      value: String(graph.edges.length),
      delta: stale.length > 0 ? `${countOf(stale.length, 'link')} stale` : 'every edge reported, none invented',
      tone: stale.length > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Cross-site links',
      value: String(crossSite.length),
      delta: 'between managed sites',
      tone: 'neutral',
    },
    {
      label: 'Neighbours filed nowhere',
      value: String(ghosts.length),
      delta: 'reported, never inventoried',
      tone: ghosts.length > 0 ? 'negative' : 'neutral',
    },
  ];
}

function hasWebGLSupport(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export default function Topology() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { pollIntervalSec } = useSettings();
  const [data, setData] = useState<TopologyData | null>(null);
  const [viewMode, setViewMode] = useState<'2d' | '3d'>(() => (hasWebGLSupport() ? '3d' : '2d'));

  /* Same poll cadence as Sites: the footer stamps a sync time, so a NOC tab
     must not sit on a mount-time snapshot under it. One fetch at a time. */
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = () => {
      if (inFlight) return;
      inFlight = true;
      void getTopology()
        .then((d) => {
          if (live) setData(d);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    pull();
    const every = Math.max(pollIntervalSec, 10) * 1000;
    const id = setInterval(pull, every);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pollIntervalSec]);

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const graph = data.graph;
  const notes = data.notes ?? [];
  const live = data.dataSource === 'live';
  const sourceLabel = live ? `LIVE · SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : 'NEVER'}` : 'DEMO FIXTURE';

  return (
    <div className="nt-stack">
      <ScreenHeader
        overline="Operate / Topology"
        title="Topology"
        subtitle="Every reported neighbour fact across every plane — sites collapsed to cards, expanded on click, provenance on every edge."
        actions={
          <div className="nt-chip-wrap nt-chip-wrap--tight">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(window.location.href).then(
                  () => toast('View link copied', { tone: 'success' }),
                  () => toast('Could not copy link', { tone: 'danger' }),
                );
              }}
            >
              Copy view link
            </Button>
            {graph.nodes.length > 0 || graph.edges.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const nNodes = exportTableCsv(
                    'topology-nodes.csv',
                    ['id', 'name', 'type', 'siteId', 'serial', 'ghost', 'planes'],
                    graph.nodes.map((n) => [
                      n.id,
                      n.name,
                      n.type ?? '',
                      n.siteId ?? '',
                      n.serial ?? '',
                      n.ghost ? 'yes' : 'no',
                      (n.planes ?? []).join('|'),
                    ]),
                  );
                  const nEdges = exportTableCsv(
                    'topology-edges.csv',
                    ['from', 'to', 'crossSite', 'stale'],
                    graph.edges.map((e) => [
                      e.from,
                      e.to,
                      e.crossSite ? 'yes' : 'no',
                      e.stale ? 'yes' : 'no',
                    ]),
                  );
                  toast(`Exported ${nNodes} nodes, ${nEdges} edges`, {
                    description: 'topology-nodes.csv and topology-edges.csv — reported facts only.',
                  });
                }}
              >
                Export CSV
              </Button>
            ) : null}
            <div
              style={{
                display: 'flex',
                gap: 6,
                background: 'var(--nd-bg-raised)',
                padding: 3,
                borderRadius: 4,
                border: '1px solid var(--nd-border-subtle)',
              }}
            >
              <Button
                size="sm"
                variant={viewMode === '3d' ? 'primary' : 'ghost'}
                onClick={() => setViewMode('3d')}
              >
                3D Graph
              </Button>
              <Button
                size="sm"
                variant={viewMode === '2d' ? 'primary' : 'ghost'}
                onClick={() => setViewMode('2d')}
              >
                2D Cards
              </Button>
            </div>
          </div>
        }
      />
      <StatRow stats={topologyStats(graph, data.dataSource)} />
      <VisualReferencePanel target={{ kind: 'estate', id: 'topology' }} />
      <ConfigRecommendationsPanel title="Topology-related recommendations" limit={6} />
      {graph.nodes.length === 0 ? (
        <EmptyState
          title="Nothing to draw yet"
          description={notes[0] ?? 'No device inventory and no neighbour facts have been reported.'}
        />
      ) : (
        <>
          {graph.omissions.length > 0 ? (
            <Alert tone="warning" title="Some reported wiring is not drawn">
              <ul className="nt-lh-15" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {graph.omissions.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {viewMode === '3d' ? (
            <Topology3DCanvas
              graph={graph}
              onSelectNode={(nodeId) => {
                const node = graph.nodes.find((n) => n.id === nodeId);
                if (node) {
                  navigate(
                    deviceDetailPath({
                      name: node.name,
                      plane: node.planes[0],
                      serial: node.serial ?? undefined,
                    }),
                  );
                } else if (graph.sites.some((s) => s.siteId === nodeId)) {
                  navigate(`/sites/${encodeURIComponent(nodeId)}`);
                }
              }}
            />
          ) : (
            <TopologyGraphView
              graph={graph}
              onOpenSite={(siteId) => navigate(`/sites/${encodeURIComponent(siteId)}`)}
              onOpenDevice={(node) =>
                navigate(
                  deviceDetailPath({
                    name: node.name,
                    plane: node.planes[0],
                    serial: node.serial ?? undefined,
                  }),
                )
              }
            />
          )}
          <div
            className="nt-hint-muted" style={{ lineHeight: 1.6,
              display: 'flex',
              flexDirection: 'column',
              gap: 4 }}
          >
            {notes.map((note) => (
              <span key={note}>{note}</span>
            ))}
            <span>{`${countOf(graph.nodes.length, 'node')} · ${countOf(graph.edges.length, 'reported link')} · ${sourceLabel}`}</span>
          </div>
        </>
      )}
    </div>
  );
}
