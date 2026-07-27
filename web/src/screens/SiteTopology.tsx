/**
 * web/src/screens/SiteTopology.tsx — the site's layered wiring diagram.
 *
 * Renders a shared SiteTopology (buildSiteTopology — recorded chain + AP
 * uplinks + the profile's device rows) as HTML node cards over a hairline
 * SVG edge layer. Layers run WAN side on top → edge at the bottom; nodes
 * spread evenly across the full width so the diagram breathes on wide
 * screens. APs open collapsed into one chip per parent switch (worst member
 * tone rolled up); clicking a chip swaps it for its member cards in place,
 * edges fanning out to each. Device cards click through to Device detail.
 *
 * Text stays in HTML (crisp at any width); only the hairlines are SVG, with
 * non-scaling stroke so they stay 1px under preserveAspectRatio="none".
 * Honest by construction: the builder emits no edge without recorded data,
 * and the note under the diagram says where the wiring comes from.
 */

import { useMemo, useState } from 'react';
import type { SiteTopology, Tone, TopologyLayerKey, TopologyNode } from '../../../shared';

const ROW_H = 96;
const CARD_H = 56;

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
        node.device
          ? `Open device ${node.device}`
          : `Expand ${node.label} ${node.sub}`
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
    <div style={{ display: 'flex', gap: 12 }}>
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
      <div style={{ position: 'relative', flex: 1, minWidth: 0, height }}>
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
