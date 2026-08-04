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
 *
 * A **Plane** chip row (counts over the q+type+ghosts universe) toggles the
 * same `?plane=` as the plane Select, a **Type** chip row (counts over the
 * q+plane+ghosts universe) toggles the same `?type=` as the device-type Select,
 * and a **Ghosts** chip row (counts over q+plane+type — Loop 148) toggles the
 * same `?ghosts=` as the Ghosts-only Switch —
 * click either again to clear. Header **LIVE** stamps pure live and blend feeds
 * alike; the footer provenance stamp follows the same rule (Loop 163).
 *
 * Filtered **nodes** table multi-select (Loop 186) raises **Export selected**,
 * **Copy serials** (unique newline-joined inventory serials — Devices pattern),
 * **Copy names** (unique newline-joined node names for hand-offs when serials are
 * sparse — Sites pattern; Loop 223), **Copy selection link** (`?ids=` of marked
 * node ids — Sites pattern; clearable chip), and **Clear**. Full graph CSV stays
 * in the header. Nodes table carries keyboard shortcuts help
 * (`?` / DATATABLE_ROW_SHORTCUTS — Loop 192). Filtered / bare empties offer
 * **Clear filters** / **Inventory** / **Connected systems** (Loop 192).
 * Selection-empty `?ids=` offers **Clear selection filter** (Loop 208).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { countOf, filterTopologyGraph, hhmmLocal as hhmm } from '@hpe/shared';
import type {
  DeviceType,
  StatDef,
  TopologyGraph,
  TopologyGraphEdge,
  TopologyGraphNode,
  TopologyGraphSite,
} from '@hpe/shared';
import {
  PageSkeleton,
  Alert,
  Badge,
  Button,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  EmptyState,
  Input,
  KeyboardShortcuts,
  SectionHeader,
  Select,
  Switch,
  useToast,
  type DataTableColumn,
} from '../nightdesk';
import { getTopology } from '../api/client';
import type { TopologyData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { deviceDetailPath, namesFilterForParam } from '../app/nav';
import { ScreenHeader } from './ScreenHeader';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { Topology3DCanvas } from './Topology3DCanvas';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { DeviceTypeBadge } from '../components/DeviceTypeBadge';

/** Re-export for screen tests that import the helper from this module. */
export { filterTopologyGraph };

export const UNFILED_KEY = '__filed-nowhere__';

export type TopologyFocus = { kind: 'site' | 'node'; id: string };

/** Parse `focus=site:ID` / `focus=node:ID` from the share URL. */
export function focusFromParam(raw: string | null): TopologyFocus | null {
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const kind = raw.slice(0, sep);
  const id = raw.slice(sep + 1).trim();
  if (!id) return null;
  if (kind === 'site' || kind === 'node') return { kind, id };
  return null;
}

export function focusToParam(focus: TopologyFocus | null): string | null {
  if (!focus) return null;
  return `${focus.kind}:${focus.id}`;
}


/** Unique plane labels present on the graph (for the filter Select). */
export function topologyPlaneOptions(graph: TopologyGraph): string[] {
  const set = new Set<string>();
  for (const n of graph.nodes) for (const p of n.planes) set.add(p);
  for (const s of graph.sites) for (const p of s.planes) set.add(p);
  return [...set].sort();
}

/** Unique non-empty node.type labels present on the graph (for the type filter). */
export function topologyTypeOptions(graph: TopologyGraph): string[] {
  const set = new Set<string>();
  for (const n of graph.nodes) {
    const t = (n.type ?? '').trim();
    if (t) set.add(t);
  }
  return [...set].sort();
}

const topologyNodeColumns: Array<DataTableColumn<TopologyGraphNode>> = [
  {
    key: 'name',
    title: 'Node',
    hideable: false,
    sortValue: (n) => n.name,
    render: (n) => (
      <span>
        <strong>{n.name}</strong>
        {n.ghost ? (
          <small className="nt-hint-muted nt-ml-8">ghost</small>
        ) : n.siteName ? (
          <small className="nt-hint-muted nt-ml-8">{n.siteName}</small>
        ) : null}
      </span>
    ),
  },
  {
    key: 'type',
    title: 'Type',
    sortValue: (n) => n.type ?? '',
    render: (n) => {
      const known = new Set(['switch', 'ap', 'gateway', 'controller', 'sensor', 'policy']);
      if (n.type && known.has(n.type)) {
        return <DeviceTypeBadge type={n.type as DeviceType} />;
      }
      return n.type?.trim() || '—';
    },
  },
  {
    key: 'serial',
    title: 'Serial',
    sortValue: (n) => n.serial ?? '',
    render: (n) => <span className="nt-mono">{n.serial ?? '—'}</span>,
  },
  {
    key: 'planes',
    title: 'Planes',
    sortValue: (n) => (n.planes ?? []).join('|'),
    render: (n) => (
      <span className="nt-wrap-6">
        {(n.planes ?? []).map((p) => (
          <Badge key={p} plane>
            {p}
          </Badge>
        ))}
      </span>
    ),
  },
  {
    key: 'state',
    title: 'State',
    sortValue: (n) => n.state ?? '',
    render: (n) => n.state ?? '—',
  },
];

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
  onFocus: (focus: TopologyFocus) => void;
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
      className="nt-topo-site-card nt-site-card"
      data-expanded={expanded ? 'true' : 'false'}
      data-focused={focused ? 'true' : 'false'}
      data-dimmed={dimmed ? 'true' : 'false'}
    >
      <button
        type="button"
        className="nt-rowlink nt-topo-site-card__head"
        data-expanded={expanded ? 'true' : 'false'}
        aria-label={
          focusActive
            ? `Focus ${site.name}`
            : expanded
              ? `Collapse ${site.name}`
              : `Expand ${site.name}`
        }
        aria-expanded={expanded}
        onClick={handleClick}
      >
        <span
          aria-hidden
          className="nt-topo-dot"
          data-tone={site.tone ?? 'neutral'}
        />
        <span className="nt-stack nt-gap-2 nt-flex-1">
          <span
            className="nt-topo-title nt-ellipsis"
          >
            {site.name}
          </span>
          <span
            className="nt-hint-muted nt-ellipsis"
          >
            {summary}
            {site.externalEdges > 0 ? ` · ${countOf(site.externalEdges, 'inter-site link')}` : ''}
            {expanded ? ' · collapse' : ' · expand'}
          </span>
        </span>
        <span className="nt-chip-end">
          {site.planes.map((plane) => (
            <Badge key={plane} plane>
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
                  className={[`nt-hint-muted nt-ellipsis`, edge.stale ? 'nt-tone-warning' : 'nt-tone-muted'].filter(Boolean).join(" ")}
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
  onFocus: (focus: TopologyFocus) => void;
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
      className="nt-rowlink nt-topo-node"
      data-ghost={node.ghost ? 'true' : 'false'}
      data-focused={focused ? 'true' : 'false'}
      data-dimmed={dimmed ? 'true' : 'false'}
      data-tone={node.tone ?? 'neutral'}
      aria-label={
        (focusActive || node.ghost ? `Focus ${node.name}` : `Open device ${node.name}`) +
        (shownState !== null ? `, ${shownState}` : '') +
        (node.ghost ? ' — reported, not in the inventory' : '')
      }
      onClick={handleClick}
    >
      <span
        aria-hidden
        className="nt-topo-dot nt-topo-dot--sm"
        data-tone={node.tone ?? 'neutral'}
      />
      <span className="nt-stack nt-gap-0 nt-ta-left nt-min-w-0">
        <span
          className="nt-topo-title nt-ellipsis nt-mono-11"
        >
          {node.name}
        </span>
        <span
          className={[`nt-row nt-mono-label nt-ellipsis nt-row-center nt-gap-5`, shownState !== null && node.tone === "danger" ? "nt-tone-danger" : "nt-tone-muted"].filter(Boolean).join(" ")}
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
  initialFocus = null,
  onFocusChange,
}: {
  graph: TopologyGraph;
  onOpenSite: (siteId: string) => void;
  onOpenDevice: (node: TopologyGraphNode) => void;
  /** Seed focus from a share URL (`?focus=site:…` / `node:…`). */
  initialFocus?: TopologyFocus | null;
  /** Notify parent so Copy view link / URL can carry the active focus. */
  onFocusChange?: (focus: TopologyFocus | null) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocusState] = useState<TopologyFocus | null>(initialFocus);

  const setFocus = useCallback((next: TopologyFocus | null) => {
    setFocusState(next);
    onFocusChange?.(next);
  }, [onFocusChange]);

  // Re-seed when the share URL changes (e.g. colleague paste / back-forward).
  // Key by value — parent often rebuilds a fresh object with the same kind/id.
  const initialFocusKey = initialFocus ? `${initialFocus.kind}:${initialFocus.id}` : '';
  const [prevInitialFocusKey, setPrevInitialFocusKey] = useState(initialFocusKey);
  if (prevInitialFocusKey !== initialFocusKey) {
    setPrevInitialFocusKey(initialFocusKey);
    setFocusState(initialFocus);
  }

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
  }, [focus, setFocus]);

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
      <div className="nt-topology-grid">
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
            className="nt-topology-banner"
          >
            <span className="nt-mono-label">
              SITE CONNECTIONS — reported links between sites or unfiled neighbours
            </span>
            {crossing.map((edge) => (
              <span
                key={edge.id}
                className="nt-hint-muted nt-topo-edge-lit"
                data-stale={edge.stale ? 'true' : 'false'}
                data-lit={edgeIsLit(edge) ? 'true' : 'false'}
              >
                {topologyEdgeLabel(edge, nodeById)}
              </span>
            ))}
          </section>
        ) : null}

        {unfiled.length > 0 ? (
          <section
            aria-label="Reported neighbours without inventory"
            className="nt-topology-banner nt-topology-banner--dashed"
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<TopologyData | null>(null);

  const q = searchParams.get('q') ?? '';
  const plane = searchParams.get('plane') ?? 'all';
  const typeFilter = searchParams.get('type') ?? 'all';
  const ghostsRaw = (searchParams.get('ghosts') ?? '').trim().toLowerCase();
  const ghostsOnly =
    ghostsRaw === '1' || ghostsRaw === 'true' || ghostsRaw === 'yes' || ghostsRaw === 'on';
  const viewParam = searchParams.get('view');
  const resolvedDefaultView: '2d' | '3d' = hasWebGLSupport() ? '3d' : '2d';
  const viewMode: '2d' | '3d' =
    viewParam === '2d' || viewParam === '3d' ? viewParam : resolvedDefaultView;
  const focusParam = focusFromParam(searchParams.get('focus'));
  const [focus, setFocus] = useState<TopologyFocus | null>(focusParam);
  /* Keyboard multi-select on filtered nodes raises Export selected /
   * Copy serials / Copy selection link (?ids=; Loop 186). */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /topology?ids=a\nb (bulk Copy selection link). */
  const idsFilterKey = searchParams.get('ids') ?? '';
  const idsFilterLc = useMemo(() => {
    const ids = namesFilterForParam(idsFilterKey);
    return ids === null ? null : ids.map((id) => id.trim().toLowerCase()).filter(Boolean);
  }, [idsFilterKey]);

  const focusParamKey = focusParam ? `${focusParam.kind}:${focusParam.id}` : '';
  const [prevFocusParamKey, setPrevFocusParamKey] = useState(focusParamKey);
  if (prevFocusParamKey !== focusParamKey) {
    setPrevFocusParamKey(focusParamKey);
    setFocus(focusParam);
  }

  const patchParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  };

  /* Persist the resolved canvas mode when the address bar omits `view` so
   * refresh / Copy view link / colleague paste always match what is drawn
   * (WebGL → 3d, otherwise 2d). Explicit `view=2d|3d` is left alone. */
  useEffect(() => {
    if (viewParam === '2d' || viewParam === '3d') return;
    const next = new URLSearchParams(searchParams);
    next.set('view', resolvedDefaultView);
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [viewParam, resolvedDefaultView, searchParams, setSearchParams]);

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

  const fullGraph = data?.graph;
  /* Type chips count over q+plane+ghosts (not type); plane chips over
   * q+type+ghosts (not plane); ghosts chips over q+plane+type (not ghosts) so
   * each row still shows the full mix while its own chip is on (Loop 148). */
  const typeUniverse = useMemo(() => {
    if (!fullGraph) return null;
    return filterTopologyGraph(fullGraph, { q, plane, ghostsOnly, type: 'all' });
  }, [fullGraph, q, plane, ghostsOnly]);
  const planeUniverse = useMemo(() => {
    if (!fullGraph) return null;
    return filterTopologyGraph(fullGraph, { q, plane: 'all', ghostsOnly, type: typeFilter });
  }, [fullGraph, q, typeFilter, ghostsOnly]);
  const ghostsUniverse = useMemo(() => {
    if (!fullGraph) return null;
    return filterTopologyGraph(fullGraph, { q, plane, ghostsOnly: false, type: typeFilter });
  }, [fullGraph, q, plane, typeFilter]);
  const filteredGraph = useMemo(() => {
    if (!fullGraph) return null;
    return filterTopologyGraph(fullGraph, { q, plane, ghostsOnly, type: typeFilter });
  }, [fullGraph, q, plane, ghostsOnly, typeFilter]);
  /* Selection deep-link narrows the nodes table (and keeps graph filter bar). */
  const tableNodes = useMemo(() => {
    const nodes = filteredGraph?.nodes ?? fullGraph?.nodes ?? [];
    if (idsFilterLc === null) return nodes;
    return nodes.filter((n) => idsFilterLc.includes(n.id.trim().toLowerCase()));
  }, [filteredGraph, fullGraph, idsFilterLc]);
  const idsPresent =
    idsFilterLc === null
      ? 0
      : idsFilterLc.filter((id) =>
          (filteredGraph?.nodes ?? fullGraph?.nodes ?? []).some(
            (n) => n.id.trim().toLowerCase() === id,
          ),
        ).length;

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const graph = filteredGraph ?? data.graph;
  const notes = data.notes ?? [];
  const sectionLive =
    data.dataSource === 'live' || (data.blended?.includes('topology') ?? false);
  const sourceLabel = sectionLive
    ? `LIVE · SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : 'NEVER'}`
    : 'DEMO FIXTURE';
  const planeOptions = topologyPlaneOptions(data.graph);
  const typeOptions = topologyTypeOptions(data.graph);
  const typeChipKeys = topologyTypeOptions(typeUniverse ?? data.graph);
  if (
    typeFilter !== 'all' &&
    typeFilter !== '' &&
    !typeChipKeys.some((t) => t.toLowerCase() === typeFilter.toLowerCase())
  ) {
    typeChipKeys.unshift(typeFilter);
  }
  const typeChips = typeChipKeys
    .map((key) => ({
      key,
      label: key,
      count: (typeUniverse ?? data.graph).nodes.filter(
        (n) => (n.type ?? '').trim().toLowerCase() === key.toLowerCase(),
      ).length,
    }))
    .filter((c) => c.count > 0 || c.key.toLowerCase() === typeFilter.toLowerCase());
  const planeChipKeys = topologyPlaneOptions(planeUniverse ?? data.graph);
  if (
    plane !== 'all' &&
    plane !== '' &&
    !planeChipKeys.some((p) => p.toLowerCase() === plane.toLowerCase())
  ) {
    planeChipKeys.unshift(plane);
  }
  const planeChips = planeChipKeys
    .map((key) => ({
      key,
      label: key,
      count: (planeUniverse ?? data.graph).nodes.filter((n) =>
        n.planes.some((p) => p.toLowerCase() === key.toLowerCase()),
      ).length,
    }))
    .filter((c) => c.count > 0 || c.key.toLowerCase() === plane.toLowerCase());
  const ghostsBase = ghostsUniverse ?? data.graph;
  const ghostNodeCount = ghostsBase.nodes.filter((n) => n.ghost).length;
  /* Ghosts chip toggles the same ghosts=1 as the Switch — click again to clear. */
  const ghostsChips =
    ghostNodeCount > 0 || ghostsOnly
      ? [{ key: '1' as const, label: 'Ghosts', tone: 'warning' as const, count: ghostNodeCount }]
      : [];
  const filtersActive =
    Boolean(q.trim()) ||
    (plane !== 'all' && plane !== '') ||
    (typeFilter !== 'all' && typeFilter !== '') ||
    ghostsOnly;

  const buildShareUrl = () => {
    const next = new URLSearchParams();
    if (q.trim()) next.set('q', q.trim());
    if (plane !== 'all' && plane !== '') next.set('plane', plane);
    if (typeFilter !== 'all' && typeFilter !== '') next.set('type', typeFilter);
    if (ghostsOnly) next.set('ghosts', '1');
    if (viewMode === '2d') next.set('view', '2d');
    else if (viewMode === '3d') next.set('view', '3d');
    const fp = focusToParam(focus);
    if (fp) next.set('focus', fp);
    const qs = next.toString();
    return `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
  };

  return (
    <div className="nt-stack nt-recon-reveal nt-topology-shell nt-section-panel">
      <ScreenHeader
        overline="Operate / Topology"
        title="Topology"
        subtitle="Every reported neighbour fact across every plane — sites collapsed to cards, expanded on click, provenance on every edge."
        actions={
          <div className="nt-chip-wrap nt-chip-wrap--tight">
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              HPE Network Tools · graph
            </span>
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const url = buildShareUrl();
                void navigator.clipboard.writeText(url).then(
                  () =>
                    toast('View link copied', {
                      description: url.includes('?') ? url.split('?')[1] : 'full estate topology',
                      tone: 'success',
                    }),
                  () => toast('Could not copy link', { description: url, tone: 'danger' }),
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
                    description: filtersActive
                      ? 'Filtered view — topology-nodes.csv and topology-edges.csv.'
                      : 'topology-nodes.csv and topology-edges.csv — reported facts only.',
                  });
                }}
              >
                Export CSV
              </Button>
            ) : null}
            {data.dataSource === 'live' && (data.graph.nodes.length > 0 || data.graph.edges.length > 0) ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void (async () => {
                      const qs = new URLSearchParams();
                      qs.set('part', 'nodes');
                      if (q.trim()) qs.set('q', q.trim());
                      if (plane !== 'all' && plane !== '') qs.set('plane', plane);
                      if (typeFilter !== 'all' && typeFilter !== '') qs.set('type', typeFilter);
                      if (ghostsOnly) qs.set('ghosts', '1');
                      const res = await downloadApiCsv(
                        `/api/topology/export?${qs.toString()}`,
                        'topology-nodes.csv',
                      );
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: filtersActive
                            ? 'topology-nodes.csv — filtered reported graph nodes.'
                            : 'topology-nodes.csv — reported graph nodes.',
                          tone: 'success',
                        });
                      } else {
                        toast('Server CSV failed', {
                          description: res.error ?? 'Could not download export',
                          tone: 'warning',
                        });
                      }
                    })();
                  }}
                >
                  Download server CSV (nodes)
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void (async () => {
                      const qs = new URLSearchParams();
                      qs.set('part', 'edges');
                      if (q.trim()) qs.set('q', q.trim());
                      if (plane !== 'all' && plane !== '') qs.set('plane', plane);
                      if (typeFilter !== 'all' && typeFilter !== '') qs.set('type', typeFilter);
                      if (ghostsOnly) qs.set('ghosts', '1');
                      const res = await downloadApiCsv(
                        `/api/topology/export?${qs.toString()}`,
                        'topology-edges.csv',
                      );
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: filtersActive
                            ? 'topology-edges.csv — filtered reported neighbour edges.'
                            : 'topology-edges.csv — reported neighbour edges.',
                          tone: 'success',
                        });
                      } else {
                        toast('Server CSV failed', {
                          description: res.error ?? 'Could not download export',
                          tone: 'warning',
                        });
                      }
                    })();
                  }}
                >
                  Download server CSV (edges)
                </Button>
              </>
            ) : null}
            <div className="nt-topology-mode-switch">
              <Button
                size="sm"
                variant={viewMode === '3d' ? 'primary' : 'ghost'}
                onClick={() => patchParams({ view: '3d' })}
              >
                3D Graph
              </Button>
              <Button
                size="sm"
                variant={viewMode === '2d' ? 'primary' : 'ghost'}
                onClick={() => patchParams({ view: '2d' })}
              >
                2D Cards
              </Button>
            </div>
          </div>
        }
      />
      <div className="nt-plane-theater" role="note">HPE Network Tools · graph theater · path · focus node</div>
      <div className="nt-status-ribbon nt-topology-ribbon" role="status" aria-label="Topology status ribbon">
        <span className="nt-status-ribbon__item">graph · path focus</span>
        <span className="nt-status-ribbon__item">node cinema</span>
        <span className="nt-status-ribbon__item">planes monochrome</span>
      </div>
      <StatRow stats={topologyStats(graph, data.dataSource)} />
      <div className="nt-filter-bar nt-gap-10">
        <Input
          aria-label="Filter topology"
          placeholder="Filter sites, devices, serials…"
          value={q}
          onChange={(e) => patchParams({ q: e.target.value || null })}
        />
        <Select
          aria-label="Plane filter"
          value={plane}
          onChange={(e) => patchParams({ plane: e.target.value === 'all' ? null : e.target.value })}
        >
          <option value="all">All planes</option>
          {planeOptions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Device type filter"
          value={typeFilter}
          onChange={(e) => patchParams({ type: e.target.value === 'all' ? null : e.target.value })}
        >
          <option value="all">All types</option>
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Switch
          checked={ghostsOnly}
          onCheckedChange={(on) => patchParams({ ghosts: on ? '1' : null })}
          label="Ghosts only"
          aria-label="Ghosts only"
        />
        {filtersActive ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => patchParams({ q: null, plane: null, type: null, ghosts: null })}
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {planeChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Topology plane">
          <span className="nt-chip-row__label">Plane</span>
          {planeChips.map((c) => {
            const active = plane.toLowerCase() === c.key.toLowerCase();
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => patchParams({ plane: active ? null : c.key })}
                className={active ? 'nt-chip nt-chip--active' : 'nt-chip'}
                aria-pressed={active}
              >
                <Badge tone="neutral">{c.label}</Badge>
                <span className="nt-chip__count">{c.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {typeChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Device type">
          <span className="nt-chip-row__label">Type</span>
          {typeChips.map((c) => {
            const active = typeFilter.toLowerCase() === c.key.toLowerCase();
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => patchParams({ type: active ? null : c.key })}
                className={active ? 'nt-chip nt-chip--active' : 'nt-chip'}
                aria-pressed={active}
              >
                <Badge tone="neutral">{c.label}</Badge>
                <span className="nt-chip__count">{c.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {ghostsChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Topology ghosts">
          <span className="nt-chip-row__label">Ghosts</span>
          {ghostsChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => patchParams({ ghosts: ghostsOnly ? null : '1' })}
              className={
                ghostsOnly ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={ghostsOnly}
              data-ghosts={c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      {graph.nodes.length === 0 ? (
        <EmptyState
          title={filtersActive ? 'Nothing matches that filter' : 'Nothing to draw yet'}
          description={
            filtersActive
              ? 'Widen the text/plane filter or clear ghosts-only to restore the estate graph.'
              : (notes[0] ?? 'No device inventory and no neighbour facts have been reported.')
          }
        >
          {filtersActive ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => patchParams({ q: null, plane: null, type: null, ghosts: null })}
            >
              Clear filters
            </Button>
          ) : (
            <span className="nt-row nt-gap-8">
              <Button variant="secondary" size="sm" onClick={() => navigate('/inventory')}>
                Inventory
              </Button>
              <Button variant="ghost" size="sm" onClick={() => navigate('/systems')}>
                Connected systems
              </Button>
            </span>
          )}
        </EmptyState>
      ) : (
        <>
          {graph.omissions.length > 0 ? (
            <Alert tone="warning" title="Some reported wiring is not drawn">
              <ul className="nt-lh-15 nt-list-tight">
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
              initialFocus={focusParam}
              onFocusChange={(next) => {
                setFocus(next);
                patchParams({ focus: focusToParam(next) });
              }}
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
          <div className="nt-stack nt-gap-10">
            <div className="nt-row-between">
              <SectionHeader
                label="Nodes"
                meta={`${countOf(tableNodes.length, 'NODE').toUpperCase()}${
                  idsFilterLc !== null || filtersActive ? ' · FILTERED' : ''
                }`}
              />
              <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
            </div>
            {idsFilterLc !== null ? (
              <div className="nt-chip-row" role="group" aria-label="Selection deep link">
                <button
                  type="button"
                  onClick={() => {
                    patchParams({ ids: null });
                    setSelectedKeys([]);
                  }}
                  title={idsFilterLc?.join(', ')}
                  className="nt-chip nt-chip--active"
                >
                  {idsPresent === idsFilterLc.length
                    ? `${idsFilterLc.length} selected node${idsFilterLc.length === 1 ? '' : 's'}`
                    : `${idsPresent} of ${idsFilterLc.length} selected nodes present`}
                  {' — clear'}
                </button>
              </div>
            ) : null}
            {tableNodes.length === 0 ? (
              idsFilterLc !== null ? (
                <div className="nt-stack nt-gap-8">
                  <div className="nt-service-note">
                    No topology nodes match the selection deep link — clear the selection filter to
                    restore the filtered node list.
                  </div>
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        patchParams({ ids: null });
                        setSelectedKeys([]);
                      }}
                    >
                      Clear selection filter
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="nt-service-note">No nodes in the current filter.</div>
              )
            ) : (
              <DataTable
                ariaLabel="Topology nodes"
                density="compact"
                columns={topologyNodeColumns}
                rows={tableNodes}
                rowKey={(n) => n.id}
                selectedKeys={selectedKeys}
                onSelectionChange={setSelectedKeys}
                onRowActivate={(node) =>
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
            {selectedKeys.length > 0 ? (
              <div
                className="nt-configure-bulk-bar nt-bulk-glass"
                role="region"
                aria-label="Topology node selection actions"
              >
                <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
                <span className="nt-configure-bulk-bar__hint">
                  export, copy serials / names, or share a selection link for only the nodes you marked — full
                  graph CSV stays in the header
                </span>
                <span className="nt-configure-bulk-bar__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const selected = new Set(selectedKeys);
                      const picked = tableNodes.filter((n) => selected.has(n.id));
                      if (picked.length === 0) {
                        toast('No selected nodes still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const n = exportTableCsv(
                        'topology-nodes-selected.csv',
                        ['id', 'name', 'type', 'siteId', 'serial', 'ghost', 'planes', 'state'],
                        picked.map((node) => [
                          node.id,
                          node.name,
                          node.type ?? '',
                          node.siteId ?? '',
                          node.serial ?? '',
                          node.ghost ? 'yes' : 'no',
                          (node.planes ?? []).join('|'),
                          node.state ?? '',
                        ]),
                      );
                      toast(`Exported ${countOf(n, 'selected node')}`, {
                        description: 'topology-nodes-selected.csv — filtered fields only.',
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
                        const selected = new Set(selectedKeys);
                        const picked = tableNodes.filter((n) => selected.has(n.id));
                        if (picked.length === 0) {
                          toast('No selected nodes still in view', {
                            description: 'Clear selection or adjust filters.',
                            tone: 'info',
                          });
                          return;
                        }
                        const serials = [
                          ...new Set(
                            picked
                              .map((n) => (n.serial ?? '').trim())
                              .filter((serial) => serial && serial !== '—'),
                          ),
                        ];
                        if (serials.length === 0) {
                          toast('No serials on the selected nodes', {
                            description:
                              'Those rows did not publish a serial — use Copy names or export CSV instead.',
                            tone: 'info',
                          });
                          return;
                        }
                        const text = serials.join('\n');
                        try {
                          await navigator.clipboard.writeText(text);
                          toast(`Copied ${countOf(serials.length, 'serial')}`, {
                            description:
                              serials.length < picked.length
                                ? `${picked.length - serials.length} selected without a serial skipped`
                                : 'newline-joined · paste into a ticket or RMA',
                            tone: 'success',
                          });
                        } catch {
                          toast('Could not copy serials', { description: text, tone: 'warning' });
                        }
                      })();
                    }}
                  >
                    Copy serials
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void (async () => {
                        const selected = new Set(selectedKeys);
                        const picked = tableNodes.filter((n) => selected.has(n.id));
                        if (picked.length === 0) {
                          toast('No selected nodes still in view', {
                            description: 'Clear selection or adjust filters.',
                            tone: 'info',
                          });
                          return;
                        }
                        const names = [
                          ...new Set(
                            picked
                              .map((n) => (n.name ?? '').trim())
                              .filter((name) => name && name !== '—'),
                          ),
                        ];
                        if (names.length === 0) {
                          toast('No names on the selected nodes', {
                            description: 'Those rows did not publish a name — export CSV instead.',
                            tone: 'info',
                          });
                          return;
                        }
                        const text = names.join('\n');
                        try {
                          await navigator.clipboard.writeText(text);
                          toast(`Copied ${countOf(names.length, 'name')}`, {
                            description:
                              names.length < picked.length
                                ? `${picked.length - names.length} selected without a name skipped`
                                : 'newline-joined · paste into a ticket or change window',
                            tone: 'success',
                          });
                        } catch {
                          toast('Could not copy names', { description: text, tone: 'warning' });
                        }
                      })();
                    }}
                  >
                    Copy names
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void (async () => {
                        const selected = new Set(selectedKeys);
                        const picked = tableNodes.filter((n) => selected.has(n.id));
                        if (picked.length === 0) {
                          toast('No selected nodes still in view', {
                            description: 'Clear selection or adjust filters.',
                            tone: 'info',
                          });
                          return;
                        }
                        const next = new URLSearchParams(searchParams);
                        next.set('ids', picked.map((n) => n.id).join('\n'));
                        const qs = next.toString();
                        const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                        try {
                          await navigator.clipboard.writeText(url);
                          toast('Selection link copied', {
                            description: `${picked.length} node${picked.length === 1 ? '' : 's'} · ids=`,
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
                  <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                    Clear
                  </Button>
                </span>
              </div>
            ) : null}
          </div>
          <div className="nt-hint-muted nt-stack-lh">
            {notes.map((note) => (
              <span key={note}>{note}</span>
            ))}
            <span>{`${countOf(graph.nodes.length, 'node')} · ${countOf(graph.edges.length, 'reported link')} · ${sourceLabel}${filtersActive ? ' · filtered' : ''}`}</span>
          </div>
        </>
      )}

      {/* Reference material and advisory panels sit below the data they
          describe. Rendered above it they pushed the primary table several
          hundred pixels down the page — on a queue screen the queue is what
          the operator came for, not the suggestions about it. */}
      <VisualReferencePanel target={{ kind: 'estate', id: 'topology' }} />
      <ConfigRecommendationsPanel title="Topology-related recommendations" category="redundancy" limit={6} />
    </div>
  );
}
