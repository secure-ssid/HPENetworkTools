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
 * Text stays in HTML (crisp at any width); only the hairlines are SVG, with
 * non-scaling stroke so they stay 1px under preserveAspectRatio="none".
 * Honest by construction: the builder emits no edge without recorded data,
 * and the note under the diagram says where the wiring comes from.
 */

import { useMemo, useState } from 'react';
import type {
  SiteDeviceRow,
  SiteTopology,
  SiteTopologyLive,
  Tone,
  TopologyDeviceNode,
  TopologyLayerKey,
  TopologyLink,
  TopologyNode,
} from '@hpe/shared';
import { countOf } from '@hpe/shared';
import { relativeAge } from '@hpe/shared';

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

/** Status-dot colours — the same token map the client path chain uses. */
const DOT: Partial<Record<Tone, string>> = {
  success: 'var(--nd-success)',
  warning: 'var(--nd-warning)',
  danger: 'var(--nd-danger)',
  neutral: 'var(--nd-border-strong)',
  accent: 'var(--nd-accent)',
  info: 'var(--nd-info, var(--nd-border-strong))',
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
 * Port-to-port wording for an undirected physical link.
 *
 * Only the exceptions are worded. A forwarding, plane-discovered, healthy
 * link is the ordinary case and says nothing beyond its ports and speed;
 * every phrase added here is one an operator has to act on.
 */
export function liveTopologyLinkFact(link: TopologyLink, forward = true): string {
  const near = (forward ? link.fromPorts : link.toPorts).map((p) => p.name).filter(Boolean);
  const far = (forward ? link.toPorts : link.fromPorts).map((p) => p.name).filter(Boolean);
  const stp = (link.stpState ?? '').trim();
  const manual = (link.edgeType ?? '').trim().toLowerCase() === 'manual';
  return [
    near.length || far.length ? `${near.join('+') || '?'} ↔ ${far.join('+') || '?'}` : null,
    formatBps(link.speedBps),
    // A link STP has blocked is up, healthy, at full speed and carrying
    // nothing. Drawn without this it is the twin of the link beside it that
    // is doing all the work, and it is usually the answer to why.
    stp !== '' && stp.toLowerCase() !== 'forwarding' ? `STP ${stp.toLowerCase()}` : null,
    // 'Manual' means somebody asserted this adjacency; 'System' means the
    // plane observed it. A diagram is read as what the plane can see, so an
    // asserted edge has to say that it is one.
    manual ? 'added manually' : null,
    // Two members of one stack joined by their stacking cable. It looks like
    // an uplink and is not one: it carries no user traffic, cannot be
    // re-patched, and losing it splits a device rather than a path.
    link.isSibling === true ? 'stack link' : null,
    link.health && link.health.toLowerCase() !== 'good'
      ? `link ${link.health.toLowerCase()}`
      : null,
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
    note: `${plane} reports these links as physical adjacency, not traffic direction or internet routing. No Internet hop is inferred, and unmanaged neighbors keep the names the plane supplied.`,
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
}: {
  placed: Placed;
  onDevice?: (name: string) => void;
  onToggleGroup?: (id: string) => void;
}) {
  const { node, xPct, layerIdx } = placed;
  const isGroup = node.members !== null;
  const clickable = node.device !== null || isGroup;
  const shownState = stateWorthDrawing(node.state);
  const inner = (
    <>
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: DOT[node.tone] ?? 'var(--nd-border-strong)',
          flex: '0 0 9px',
        }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, textAlign: 'left' }}>
        <span
          style={{
            fontFamily: 'var(--nd-font-display)',
            fontSize: 12.5,
            color: 'var(--nd-text-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {node.label}
        </span>
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 9.5,
            letterSpacing: '.06em',
            color: 'var(--nd-text-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {isGroup ? `${node.sub} · expand` : node.sub}
        </span>
        {/* The dot is aria-hidden and the border is a colour. Without this
            line the only thing the diagram says about a device is one it says
            in red — unreadable to a screen reader, and to the roughly one
            operator in twelve who cannot tell it from the green beside it. */}
        {shownState !== null ? (
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 9.5,
              letterSpacing: '.06em',
              color: node.tone === 'danger' ? 'var(--nd-danger)' : 'var(--nd-warning)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {shownState}
          </span>
        ) : null}
      </span>
    </>
  );
  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${xPct}%`,
    top: layerIdx * ROW_H + (ROW_H - CARD_H) / 2,
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: 168,
    height: CARD_H,
    padding: '0 12px',
    background: 'var(--nd-bg-raised)',
    border: `1px solid ${node.tone === 'danger' ? 'var(--nd-danger)' : 'var(--nd-border-subtle)'}`,
    borderRadius: 2,
    cursor: clickable ? 'pointer' : 'default',
  };
  if (!clickable) {
    return (
      <div key={node.id} style={style}>
        {inner}
      </div>
    );
  }
  return (
    <button
      key={node.id}
      type="button"
      className="nt-rowlink"
      aria-label={
        (node.device ? `Open device ${node.device}` : `Expand ${node.label} ${node.sub}`) +
        (shownState !== null ? `, ${shownState}` : '')
      }
      onClick={() => (node.device ? onDevice?.(node.device) : onToggleGroup?.(node.id))}
      style={{ ...style, font: 'inherit' }}
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggleGroup = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  return (
    <div style={{ display: 'flex', gap: 12, overflowX: 'auto' }}>
      {/* layer micro-labels */}
      <div style={{ width: 64, flex: '0 0 64px', position: 'relative', height }}>
        {topology.layers.map((layer, i) => (
          <span
            key={layer}
            style={{
              position: 'absolute',
              top: i * ROW_H + ROW_H / 2,
              transform: 'translateY(-50%)',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 9.5,
              letterSpacing: '.12em',
              color: 'var(--nd-text-muted)',
            }}
          >
            {LAYER_LABEL[layer]}
          </span>
        ))}
      </div>

      {/* diagram area */}
      <div style={{ position: 'relative', flex: '1 0 auto', minWidth: diagramMinWidth, height }}>
        <svg
          aria-hidden
          width="100%"
          height="100%"
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0 }}
        >
          {topology.edges.flatMap((e, i) => {
            const froms = targetsFor(e.from);
            const tos = targetsFor(e.to);
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
          return (
            <span
              key={`label-${i}`}
              style={{
                position: 'absolute',
                left: `${(f.xPct + t.xPct) / 2}%`,
                top: (f.layerIdx + t.layerIdx + 1) * ROW_H - 7,
                transform: 'translate(-50%, -50%)',
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 9.5,
                letterSpacing: '.04em',
                color: 'var(--nd-text-muted)',
                background: 'var(--nd-bg-surface)',
                padding: '0 6px',
                whiteSpace: 'nowrap',
              }}
            >
              {e.label}
            </span>
          );
        })}

        {placed.map((p) => (
          <Card key={p.node.id} placed={p} onDevice={onDevice} onToggleGroup={toggleGroup} />
        ))}
      </div>
    </div>
  );
}
