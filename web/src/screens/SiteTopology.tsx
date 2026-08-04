/**
 * web/src/screens/SiteTopology.tsx — the site's layered wiring diagram.
 *
 * Renders a shared SiteTopology as HTML node cards over a hairline SVG edge
 * layer. The view model may come from buildSiteTopology (recorded profile
 * wiring) or buildLiveSiteTopology (a plane's raw physical graph). Layers run
 * WAN side on top → edge at the bottom; nodes spread evenly across the full
 * width, with dense live layers scrolling rather than overlapping. Recorded
 * AP groups open in place. Device cards click through to Device detail.
 *
 * Focus mode: shift+click any card (or plain-click a card with no other
 * action) to isolate it with its 1-hop neighbours — everything else dims,
 * cards and edges alike. While a focus is active every card click moves it
 * (navigation is suspended, never triggered); the exit chip, Esc or a click
 * on the diagram background restores the full graph.
 *
 * Text stays in HTML (crisp at any width); only the hairlines are SVG, with
 * non-scaling stroke so they stay 1px under preserveAspectRatio="none".
 * Honest by construction: the builder emits no edge without recorded data,
 * edge labels carry the plane's own port/speed/bundle/health words verbatim,
 * and the note under the diagram says where the wiring comes from.
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  SiteDeviceRow,
  SiteTopology,
  SiteTopologyLive,
  Tone,
  TopologyDeviceNode,
  TopologyLayerKey,
  TopologyLink,
  TopologyLinkPort,
  TopologyNode,
} from '@hpe/shared';
import { countOf } from '@hpe/shared';
import { relativeAge } from '@hpe/shared';
import { Badge, Button, useToast } from '../nightdesk';
import { exportTableCsv } from '../lib/csv';

/** Canonical share target for the site topology diagram section. */
export function siteTopologySectionUrl(
  pathname: string = typeof window !== 'undefined' ? window.location.pathname : '',
): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const base = pathname || '/sites';
  return `${origin}${base}?section=topology#topology`;
}

const ROW_H = 96;
const CARD_H = 56;

/**
 * States that need no words. Everything else — down, offline, degraded,
 * unknown, 'no heartbeat' — is drawn as text on the card, because the diagram
 * otherwise says it in red and nothing else, and a red dot is not something
 * every operator looking at the screen can read.
 */
const QUIET_STATES = new Set(['up', 'ok', 'online']);

function stateWorthDrawing(state: string): string | null {
  const text = state.trim();
  return text === '' || QUIET_STATES.has(text.toLowerCase()) ? null : text;
}

/**
 * How long a node has been gone.
 *
 * 'offline' is the same word for a switch that dropped four minutes ago and
 * one that was unracked in March, and those are an incident and a tidying
 * job. The stamp answers it, and TopologyDeviceNode.lastSeen already carries
 * the warning that goes with it: zero and null both mean the plane sent no
 * stamp, and neither may become 1970. A device last seen fifty-six years ago
 * answers the question with a fabrication, so an absent stamp says nothing.
 */
function lastSeenPhrase(lastSeen: number | null | undefined, now: number): string | null {
  if (typeof lastSeen !== 'number' || !Number.isFinite(lastSeen) || lastSeen <= 0) return null;
  const at = new Date(lastSeen);
  if (Number.isNaN(at.getTime())) return null;
  const age = relativeAge(at.toISOString(), now);
  return age === '—' ? null : `last seen ${age} ago`;
}

const LAYER_ORDER: TopologyLayerKey[] = ['wan', 'gateway', 'core', 'access', 'edge'];

const LAYER_LABEL: Record<TopologyLayerKey, string> = {
  wan: 'WAN',
  gateway: 'GATEWAY',
  core: 'CORE',
  access: 'ACCESS',
  edge: 'EDGE',
};

/**
 * Stack/cluster identity for one node.
 *
 * A cluster of eight switches is drawn as eight cards, which reads as eight
 * independent devices in eight failure domains. It is one logical device: the
 * conductor holds the running configuration, a change pushed to a member goes
 * nowhere, and rebooting the conductor is not the same act as rebooting a
 * member. Both facts arrive from the plane on adjacent lines of the adapter
 * and neither was drawn.
 *
 * Only the exceptional case is worded — a standalone switch is the ordinary
 * one and earns nothing.
 */
function clusterFacts(
  node: TopologyDeviceNode,
  nodeBySerial: Map<string, TopologyDeviceNode>,
): string[] {
  const conductor = (node.conductorSerial ?? '').trim();
  const deployment = (node.deployment ?? '').trim();
  if (conductor === '') {
    return deployment !== '' && deployment.toLowerCase() !== 'standalone'
      ? [deployment.toLowerCase()]
      : [];
  }
  if (conductor === node.serial) return ['conductor'];
  // Naming the conductor is the point; falling back to its serial keeps a
  // conductor that is not on this diagram visible rather than dropping it,
  // which is itself worth seeing.
  return [`member of ${nodeBySerial.get(conductor)?.name ?? conductor}`];
}

function liveTone(node: TopologyDeviceNode): Tone {
  const status = node.status.toUpperCase();
  if (status === 'OFFLINE' || status === 'DOWN') return 'danger';
  const health = (node.health ?? '').toLowerCase();
  if (health === 'poor' || health === 'bad') return 'danger';
  if (health === 'fair') return 'warning';
  if (health === 'good') return 'success';
  return 'neutral';
}

function formatBps(bps: number | null): string | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) return null;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`;
  return `${Math.round(bps)} bps`;
}

/**
 * One end of a link, worded: member ports joined by '+', with the bundle
 * named when the plane says they are one ('1/1/1+1/1/2 (Po2)') — a LAG reads
 * as a single logical port, not as two cables doing one job.
 */
function portSideText(ports: TopologyLinkPort[]): string {
  const names = ports.map((p) => p.name).filter(Boolean);
  const lags = [...new Set(ports.map((p) => (p.lag ?? '').trim()).filter((lag) => lag !== ''))];
  const joined = names.join('+');
  return lags.length > 0 && joined !== '' ? `${joined} (${lags.join('+')})` : joined;
}

/**
 * A member port the plane scored as anything but good, worded with its name.
 * The link-level verdict can read 'Good' over a bundle whose second member is
 * flapping — the carried port health is the only place that says so, and the
 * adapter already parsed it.
 */
function portHealthFacts(link: TopologyLink): string[] {
  return [...link.fromPorts, ...link.toPorts]
    .map((p) => ({ name: p.name, health: (p.health ?? '').trim() }))
    .filter((p) => p.health !== '' && p.health.toLowerCase() !== 'good')
    .map((p) => `port ${p.name} ${p.health.toLowerCase()}`);
}

/**
 * Port-to-port wording for an undirected physical link.
 *
 * Only the exceptions are worded. A forwarding, plane-discovered, healthy
 * link is the ordinary case and says nothing beyond its ports and speed;
 * every phrase added here is one an operator has to act on.
 */
export function liveTopologyLinkFact(link: TopologyLink, forward = true): string {
  const near = portSideText(forward ? link.fromPorts : link.toPorts);
  const far = portSideText(forward ? link.toPorts : link.fromPorts);
  const stp = (link.stpState ?? '').trim();
  const edgeType = (link.edgeType ?? '').trim();
  const manual = edgeType.toLowerCase() === 'manual';
  return [
    near !== '' || far !== '' ? `${near || '?'} ↔ ${far || '?'}` : null,
    formatBps(link.speedBps),
    // A link STP has blocked is up, healthy, at full speed and carrying
    // nothing. Drawn without this it is the twin of the link beside it that
    // is doing all the work, and it is usually the answer to why.
    stp !== '' && stp.toLowerCase() !== 'forwarding' ? `STP ${stp.toLowerCase()}` : null,
    // 'Manual' means somebody asserted this adjacency; 'System' means the
    // plane observed it. A diagram is read as what the plane can see, so an
    // asserted edge has to say that it is one.
    manual ? 'added manually' : null,
    // Any other edge-type word is the edge's evidence and rides verbatim:
    // Mist's AP-stats edges carry 'LLDP' — each is one AP's own report of
    // its uplink neighbour, not a plane-observed full-graph adjacency.
    !manual && edgeType !== '' && edgeType.toLowerCase() !== 'system' ? edgeType : null,
    // Two members of one stack joined by their stacking cable. It looks like
    // an uplink and is not one: it carries no user traffic, cannot be
    // re-patched, and losing it splits a device rather than a path.
    link.isSibling === true ? 'stack link' : null,
    link.health && link.health.toLowerCase() !== 'good'
      ? `link ${link.health.toLowerCase()}`
      : null,
    ...portHealthFacts(link),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/**
 * Convert a plane's raw, undirected graph into the existing diagram view
 * model. Layers are layout only: links keep ↔ wording and the note explicitly
 * refuses to infer traffic direction or internet routing.
 */
export function buildLiveSiteTopology(
  topology: SiteTopologyLive,
  devices: SiteDeviceRow[] = [],
  now: number = Date.now(),
): SiteTopology {
  const rawNodes = topology.nodes ?? [];
  const managedNames = new Set(devices.map((device) => device.name));
  const degree = new Map<string, number>();
  for (const link of topology.links ?? []) {
    degree.set(link.from, (degree.get(link.from) ?? 0) + 1);
    degree.set(link.to, (degree.get(link.to) ?? 0) + 1);
  }
  const switches = rawNodes.filter((node) => /switch/i.test(`${node.type} ${node.deviceFunction}`));
  const hubSerial =
    switches
      .slice()
      .sort(
        (a, b) =>
          (degree.get(b.serial) ?? 0) - (degree.get(a.serial) ?? 0) ||
          a.name.localeCompare(b.name),
      )[0]?.serial ?? null;

  const layerFor = (node: TopologyDeviceNode): TopologyLayerKey => {
    const kind = `${node.type} ${node.deviceFunction}`;
    if (/gateway|router|wan/i.test(kind)) return 'gateway';
    if (node.serial === hubSerial) return 'core';
    if (/switch/i.test(kind)) return 'access';
    return 'edge';
  };
  const nodeBySerial = new Map(rawNodes.map((node) => [node.serial, node]));
  const layerBySerial = new Map(rawNodes.map((node) => [node.serial, layerFor(node)]));
  const nodes: TopologyNode[] = rawNodes.map((node) => {
    const details = [
      node.model,
      node.deviceFunction && node.deviceFunction !== '-' ? node.deviceFunction.toLowerCase() : null,
      node.type.toLowerCase() === 'unmanaged' ? 'unmanaged neighbor' : null,
      ...clusterFacts(node, nodeBySerial),
    ].filter((part): part is string => Boolean(part));
    return {
      id: `live:${node.serial}`,
      layer: layerFor(node),
      label: node.name,
      sub: details.join(' · ') || node.type.toLowerCase(),
      state: [
        node.status.toLowerCase(),
        // Only where it answers something: a device the plane still sees was
        // last seen a moment ago, which is a fact about the poll, not the AP.
        stateWorthDrawing(node.status) === null ? null : lastSeenPhrase(node.lastSeen, now),
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · '),
      tone: liveTone(node),
      device: managedNames.has(node.name) ? node.name : null,
      members: null,
    };
  });
  // A link whose far end is not in the node list cannot be drawn, because
  // there is no card to draw it to. Dropping it silently leaves a switch
  // looking unconnected while the "Reported physical links" table directly
  // below still lists the link — the same read contradicting itself across
  // two panels a thumb's width apart.
  const undrawable = (topology.links ?? []).filter(
    (link) => !nodeBySerial.has(link.from) || !nodeBySerial.has(link.to),
  );
  const edges = (topology.links ?? []).flatMap((link) => {
    if (!nodeBySerial.has(link.from) || !nodeBySerial.has(link.to)) return [];
    const fromLayer = layerBySerial.get(link.from) as TopologyLayerKey;
    const toLayer = layerBySerial.get(link.to) as TopologyLayerKey;
    const forward = LAYER_ORDER.indexOf(fromLayer) <= LAYER_ORDER.indexOf(toLayer);
    return [
      {
        from: `live:${forward ? link.from : link.to}`,
        to: `live:${forward ? link.to : link.from}`,
        label: liveTopologyLinkFact(link, forward),
      },
    ];
  });
  const layers = LAYER_ORDER.filter((layer) => nodes.some((node) => node.layer === layer));
  const plane = topology.source.plane.toUpperCase();
  const drawnLinks = topology.links ?? [];
  // An all-LLDP graph is the Mist AP-stats fallback (server mistLldpTopology):
  // every edge one AP's own report of its uplink neighbour. The note has to
  // say that — reading it as the plane's observed full graph overstates both
  // its reach and its evidence.
  const allLldp =
    drawnLinks.length > 0 && drawnLinks.every((link) => (link.edgeType ?? '').trim().toLowerCase() === 'lldp');
  const omissions: string[] = [];
  if (undrawable.length > 0) {
    const ends = [
      ...new Set(
        undrawable.flatMap((link) =>
          [link.from, link.to].filter((serial) => !nodeBySerial.has(serial)),
        ),
      ),
    ];
    omissions.push(
      `${countOf(undrawable.length, 'reported link')} ${
        undrawable.length === 1 ? 'is' : 'are'
      } not drawn — ${plane} named ${ends.length === 1 ? 'an endpoint' : 'endpoints'} it did not return as ` +
        `${ends.length === 1 ? 'a node' : 'nodes'} (${ends.join(', ')}). ${
          undrawable.length === 1 ? 'It is' : 'They are'
        } listed under Reported physical links.`,
    );
  }
  // The plane volunteered this: it holds these devices for the site and could
  // not place them on the graph. Parsed by the adapter, carried across the
  // wire, and until now read by nobody — so a site whose plane said "12 of
  // these are unplaced" drew the rest and called it the topology.
  const isolated = topology.isolatedDevicesCount;
  if (typeof isolated === 'number' && isolated > 0) {
    const health = topology.isolatedHealth?.trim();
    omissions.push(
      `${plane} could not place ${countOf(isolated, 'device')} on this graph${
        health ? ` (reported health ${health.toLowerCase()})` : ''
      }, so ${isolated === 1 ? 'it is' : 'they are'} absent from the diagram. This is not a site with ` +
        `no such devices — it is a graph that does not reach them.`,
    );
  }
  return {
    layers,
    nodes,
    edges,
    note: allLldp
      ? `Each edge is one AP's own LLDP report of its uplink neighbour, read by ${plane} from the AP stats walk — ` +
        'physical adjacency only, not traffic direction, internet routing, or a full site graph.'
      : `${plane} reports these links as physical adjacency, not traffic direction or internet routing. No Internet hop is inferred, and unmanaged neighbors keep the names the plane supplied.`,
    omissions,
  };
}

interface Placed {
  node: TopologyNode;
  xPct: number;
  layerIdx: number;
}

/** One expanded member, rendered like a small device card. */
function memberNode(layer: TopologyLayerKey, m: { name: string; state: string; tone: Tone }): TopologyNode {
  return { id: `dev:${m.name}`, layer, label: m.name, sub: 'access point', state: m.state, tone: m.tone, device: m.name, members: null };
}

function Card({
  placed,
  onDevice,
  onToggleGroup,
  onFocus,
  dimmed,
  focused,
  focusActive,
}: {
  placed: Placed;
  onDevice?: (name: string) => void;
  onToggleGroup?: (id: string) => void;
  onFocus: (id: string) => void;
  dimmed: boolean;
  focused: boolean;
  focusActive: boolean;
}) {
  const { node, xPct, layerIdx } = placed;
  const isGroup = node.members !== null;
  const navigable = node.device !== null || isGroup;
  const shownState = stateWorthDrawing(node.state);
  const inner = (
    <>
      <span
        aria-hidden
        className="nt-topo-dot-9"
        data-tone={node.tone ?? 'neutral'}
      />
      <span className="nt-stack-left">
        <span
          className="nt-topo-title nt-ellipsis-primary"
        >
          {node.label}
        </span>
        <span
          className="nt-mono-label nt-ellipsis-muted"
        >
          {isGroup ? `${node.sub} · expand` : node.sub}
        </span>
        {/* The dot is aria-hidden and the border is a colour. Without this
            line the only thing the diagram says about a device is one it says
            in red — unreadable to a screen reader, and to the roughly one
            operator in twelve who cannot tell it from the green beside it. */}
        {shownState !== null ? (
          <span
            className={[`nt-mono-label`, node.tone === "danger" ? "nt-ellipsis-clamp nt-tone-danger" : "nt-ellipsis-clamp nt-tone-warning"].filter(Boolean).join(" ")}
          >
            {shownState}
          </span>
        ) : null}
      </span>
    </>
  );
  const style: React.CSSProperties = {
    ['--nd-topo-x' as string]: `${xPct}%`,
    ['--nd-topo-y' as string]: `${layerIdx * ROW_H + (ROW_H - CARD_H) / 2}px`,
    ['--nd-topo-h' as string]: `${CARD_H}px`,
    opacity: dimmed ? 0.25 : 1,
  };
  const cardTone = focused ? 'focus' : node.tone === 'danger' ? 'danger' : 'default';
  /* Focus mode's pointer rules, kept beside the only click handler: a plain
     click keeps its existing meaning (open the device, expand the group)
     while no focus is active; shift+click always focuses; and once a focus
     IS active every card click moves the focus — navigation resumes on
     exit, so a browse through a busy graph never leaves the page. A card
     with no device and no group (an unmanaged neighbour, the exit node)
     had no action before; its click now focuses it. */
  const handleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (event.shiftKey || focusActive || !navigable) {
      onFocus(node.id);
      return;
    }
    if (node.device) onDevice?.(node.device);
    else onToggleGroup?.(node.id);
  };
  return (
    <button
      key={node.id}
      type="button"
      className={`nt-rowlink nt-font-inherit nt-topo-node-card nt-topo-node-card--${cardTone}`}
      aria-label={
        (focusActive || !navigable
          ? `Focus ${node.label}`
          : node.device
            ? `Open device ${node.device}`
            : `Expand ${node.label} ${node.sub}`) + (shownState !== null ? `, ${shownState}` : '')
      }
      onClick={handleClick}
      style={style}
    >
      {inner}
    </button>
  );
}

export function SiteTopologyDiagram({
  topology,
  onDevice,
}: {
  topology: SiteTopology;
  onDevice?: (name: string) => void;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Focus mode: one node plus its 1-hop neighbours stay lit, everything else
  // dims. Entered by shift+click on any card (or a plain click on a card with
  // no other action); left via the exit chip, Esc, or a background click.
  const [focusId, setFocusId] = useState<string | null>(null);

  const toggleGroup = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 1-hop adjacency on the view model's own ids (group chips included — an
  // expanded member is focused THROUGH its chip, the id its edges carry).
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      const set = map.get(a) ?? new Set<string>();
      set.add(b);
      map.set(a, set);
    };
    for (const edge of topology.edges) {
      link(edge.from, edge.to);
      link(edge.to, edge.from);
    }
    return map;
  }, [topology.edges]);

  /* What stays lit. `core` is the focused entity itself (plus its group chip
     when an expanded member was picked); `lit` adds the 1-hop neighbours;
     `neighbours` counts just the hop. A focus target a refresh dropped from
     the model reads as no focus at all rather than dimming everything. */
  const focus = useMemo(() => {
    if (focusId === null) return null;
    const focused = topology.nodes.find(
      (n) => n.id === focusId || (n.members?.some((m) => `dev:${m.name}` === focusId) ?? false),
    );
    if (!focused) return null;
    const core = new Set<string>([focusId]);
    if (focused.id !== focusId) core.add(focused.id);
    const lit = new Set<string>(core);
    // A focused GROUP lights its members; a focused member does not light its
    // siblings — the hop reaches the parent through the chip's edges instead.
    if (focusId === focused.id && focused.members) {
      for (const m of focused.members) lit.add(`dev:${m.name}`);
    }
    const neighbours = new Set<string>();
    for (const key of core) {
      for (const next of adjacency.get(key) ?? []) {
        lit.add(next);
        neighbours.add(next);
      }
    }
    const label =
      topology.nodes.find((n) => n.id === focusId)?.label ??
      (focusId.startsWith('dev:') ? focusId.slice(4) : focusId);
    return { core, lit, neighbours, label };
  }, [focusId, adjacency, topology.nodes]);

  // Esc leaves focus mode; the listener exists only while there is a focus to
  // leave, so the diagram never swallows the key for anything else.
  useEffect(() => {
    if (focusId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocusId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focusId]);

  // Visible cards per layer: group chips swap for their members when expanded.
  const { placed, posOf } = useMemo(() => {
    const placed: Placed[] = [];
    for (const [layerIdx, layer] of topology.layers.entries()) {
      const visible: TopologyNode[] = topology.nodes.flatMap((n) => {
        if (n.layer !== layer) return [];
        if (n.members && expanded.has(n.id)) return n.members.map((m) => memberNode(layer, m));
        return [n];
      });
      visible.forEach((node, i) => placed.push({ node, xPct: ((i + 0.5) / visible.length) * 100, layerIdx }));
    }
    const posOf = new Map<string, Placed[]>();
    for (const p of placed) posOf.set(p.node.id, [p]);
    return { placed, posOf };
  }, [topology, expanded]);

  const height = topology.layers.length * ROW_H + 8;
  const layerCounts = new Map<number, number>();
  for (const item of placed) {
    layerCounts.set(item.layerIdx, (layerCounts.get(item.layerIdx) ?? 0) + 1);
  }
  const diagramMinWidth = Math.max(640, Math.max(1, ...layerCounts.values()) * 184);

  // Edge endpoints: a group target fans out to member cards when expanded.
  const targetsFor = (id: string): Placed[] => {
    const direct = posOf.get(id);
    if (direct) return direct;
    const group = topology.nodes.find((n) => n.id === id);
    if (group?.members && expanded.has(id)) {
      return placed.filter((p) => group.members!.some((m) => `dev:${m.name}` === p.node.id));
    }
    return [];
  };

  const canExport = topology.nodes.length > 0 || topology.edges.length > 0;

  const copyViewLink = () => {
    const url = siteTopologySectionUrl();
    void navigator.clipboard.writeText(url).then(
      () =>
        toast('Topology section link copied', {
          description: 'section=topology',
          tone: 'success',
        }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  return (
    <div
      className="nt-stack-gap-8 nt-recon-reveal nt-topo-surface nt-site-topo-shell nt-section-panel"
      onClick={() => {
        if (focusId !== null) setFocusId(null);
      }}
    >
      <div className="nt-plane-theater" role="note">
        HPE Network Tools · site topology · path owns attention · state owns hue
      </div>
      <div className="nt-status-ribbon nt-site-topo-ribbon" role="status" aria-label="Site topology status ribbon">
        <span className="nt-status-ribbon__item">path · owns attention</span>
        <span className="nt-status-ribbon__item">state owns hue</span>
        <span className="nt-status-ribbon__item">layers monochrome</span>
      </div>
      <div className="nt-row-wrap-10 nt-toolbar-glass" onClick={(event) => event.stopPropagation()}>
        <Button variant="ghost" size="sm" onClick={copyViewLink}>
          Copy view link
        </Button>
        {canExport ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              exportTableCsv(
                'site-topology-nodes.csv',
                ['id', 'layer', 'label', 'sub', 'state', 'device'],
                topology.nodes.map((n) => [
                  n.id,
                  n.layer,
                  n.label,
                  n.sub ?? '',
                  n.state ?? '',
                  n.device ?? '',
                ]),
              );
              exportTableCsv(
                'site-topology-edges.csv',
                ['from', 'to', 'label'],
                topology.edges.map((e) => [e.from, e.to, e.label ?? '']),
              );
            }}
          >
            Export CSV
          </Button>
        ) : null}
      </div>
      {focus !== null ? (
        <div className="nt-row-wrap-10">
          <Badge tone="accent">focus</Badge>
          <span
            className="nt-hint-muted nt-flex-1-min"
          >
            {`${focus.label} · ${countOf(focus.neighbours.size, 'neighbour')} in view · click another node to move the focus · Esc or click the background to leave`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              setFocusId(null);
            }}
          >
            Exit focus
          </Button>
        </div>
      ) : null}
      <div className="nt-row-gap-12-scroll">
        {/* layer micro-labels */}
        <div className="nt-topo-lane" style={{ ['--nd-topo-h' as string]: `${height}px` }}>
          {topology.layers.map((layer, i) => (
            <span
              key={layer}
              className="nt-mono-label nt-topo-layer-label"
              style={{ ['--nd-topo-y' as string]: `${i * ROW_H + ROW_H / 2}px` }}
            >
              {LAYER_LABEL[layer]}
            </span>
          ))}
        </div>

        {/* diagram area */}
        <div
          className="nt-topo-diagram"
          style={{
            ['--nd-topo-min-w' as string]: `${diagramMinWidth}px`,
            ['--nd-topo-h' as string]: `${height}px`,
          }}
        >
          <svg
            aria-hidden
            width="100%"
            height="100%"
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            className="nt-abs-inset"
          >
            {topology.edges.flatMap((e, i) => {
              const froms = targetsFor(e.from);
              const tos = targetsFor(e.to);
              // Focus mode: an edge is lit when it is incident to the focused
              // node itself — the hop, not everything between two lit cards.
              const edgeLit = focus === null || focus.core.has(e.from) || focus.core.has(e.to);
              return froms.flatMap((f) =>
                tos.map((t) => (
                  <line
                    key={`${i}-${f.node.id}-${t.node.id}`}
                    x1={f.xPct}
                    y1={f.layerIdx * ROW_H + ROW_H / 2 + CARD_H / 2}
                    x2={t.xPct}
                    y2={t.layerIdx * ROW_H + ROW_H / 2 - CARD_H / 2}
                    stroke="var(--nd-border-strong)"
                    strokeWidth="1"
                    strokeOpacity={edgeLit ? 1 : 0.15}
                    vectorEffect="non-scaling-stroke"
                  />
                )),
              );
            })}
          </svg>

          {/* edge labels (only where the data carries one) — HTML so text stays crisp */}
          {topology.edges.map((e, i) => {
            if (!e.label) return null;
            const f = targetsFor(e.from)[0];
            const t = targetsFor(e.to)[0];
            if (!f || !t) return null;
            const edgeLit = focus === null || focus.core.has(e.from) || focus.core.has(e.to);
            return (
              <span
                key={`label-${i}`}
                className="nt-hint-muted nt-topo-edge-tag"
                data-lit={edgeLit ? 'true' : 'false'}
                style={{
                  ['--nd-topo-x' as string]: `${(f.xPct + t.xPct) / 2}%`,
                  ['--nd-topo-y' as string]: `${(f.layerIdx + t.layerIdx + 1) * ROW_H - 7}px`,
                }}
              >
                {e.label}
              </span>
            );
          })}

          {placed.map((p) => (
            <Card
              key={p.node.id}
              placed={p}
              onDevice={onDevice}
              onToggleGroup={toggleGroup}
              onFocus={setFocusId}
              dimmed={focus !== null && !focus.lit.has(p.node.id)}
              focused={focus !== null && focus.core.has(p.node.id)}
              focusActive={focus !== null}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
