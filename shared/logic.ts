/**
 * shared/logic.ts — the prototypes' reusable behaviour, ported to clean typed
 * functions. Sources:
 *   NtDeviceDetail.dc.html — profile() / banner() / respond() / quick commands
 *   NtClients.dc.html      — pathFor() / timeline selection
 *   NtConfigure.dc.html    — renderVals() preview strings / blast radius / row seeding
 *
 * String-building is copied verbatim from the prototypes so unit tests can
 * compare output byte-for-byte against the .dc.html originals.
 */

import type {
  ApUplinkMap,
  BlastRadiusRow,
  ClientRow,
  ConfigForm,
  ConfigKind,
  DeviceProfile,
  PathHop,
  PathHopView,
  PortForm,
  PortObject,
  SiteChain,
  SiteDeviceRow,
  SiteId,
  SiteTopology,
  SsidBands,
  SsidForm,
  SsidObject,
  SsidSecurity,
  TerminalKind,
  TerminalLine,
  TimelineStep,
  Tone,
  TopologyEdge,
  TopologyLayerKey,
  TopologyNode,
  VlanForm,
  VlanObject,
} from './types';
import {
  AOS_TERMINAL_RESPONSES,
  AP_UPLINK,
  DEVICE_PROFILE_BUILDERS,
  FALLBACK_CHAIN,
  SITE_CHAIN,
  SW_TERMINAL_RESPONSES,
  TIMELINES,
} from './fixtures';

// ---------------------------------------------------------------------------
// Terminal — NtDeviceDetail profile() / banner() / respond()
// ---------------------------------------------------------------------------

/**
 * Device profile per the name-prefix rules:
 *   mm- / mc-  → AOS-8 mobility master, kind 'aos', prompt '(<name>) [mynode] #'
 *   ap- / uxi- → cloud-claimed, kind 'none' (no shell, readOnlyNote set)
 *   gw-        → AOS-10 gateway, kind 'aos', prompt '(<name>) #'
 *   cppm*      → ClearPass, kind 'sw', prompt '[appadmin@<name>]#'
 *   default    → CX switch, kind 'sw', prompt '<name>#'
 * Profile data comes from DEVICE_PROFILE_BUILDERS in fixtures.ts.
 */
export function deviceProfile(name: string): DeviceProfile {
  const n = name || 'sw-core-a';
  if (n.startsWith('mm-') || n.startsWith('mc-')) return DEVICE_PROFILE_BUILDERS.aos8Controller(n);
  if (n.startsWith('ap-') || n.startsWith('uxi-')) return DEVICE_PROFILE_BUILDERS.cloudClaimed(n);
  if (n.startsWith('gw-')) return DEVICE_PROFILE_BUILDERS.aos10Gateway(n);
  if (n.startsWith('cppm')) return DEVICE_PROFILE_BUILDERS.clearpass(n);
  return DEVICE_PROFILE_BUILDERS.cxSwitch(n);
}

/** Session banner lines — banner(). `clear` resets the buffer to this. */
export function terminalBanner(kind: TerminalKind): TerminalLine[] {
  if (kind === 'aos') {
    return [
      { text: 'Connecting via portal jump host 10.48.0.9 …', tone: 'muted' },
      { text: 'Last login: Fri Jul 25 09:12:04 2026 from 10.42.0.9', tone: 'muted' },
      { text: 'ArubaOS 8.10.0.10 — session logged to ticket NET-4173', tone: 'muted' },
      { text: '', tone: 'muted' },
    ];
  }
  return [
    { text: 'SSH session opened by r.okafor via collector-01 (10.42.0.9)', tone: 'muted' },
    { text: 'ArubaOS-CX FL.10.13.1005 — all commands are recorded', tone: 'muted' },
    { text: 'Type ? for the command list this portal can proxy.', tone: 'muted' },
    { text: '', tone: 'muted' },
  ];
}

/** Quick-command chips per device kind. */
export function terminalQuickCommands(kind: TerminalKind): string[] {
  return kind === 'aos'
    ? ['show version', 'show switches', 'show ap database', 'show datapath tunnel']
    : ['show version', 'show system', 'show interface brief', 'show vlan', 'show lldp neighbor'];
}

/**
 * Canned-shell responder — respond(). Returns the lines to append, or null as
 * the clear sentinel (caller resets the buffer to terminalBanner(kind)).
 * '?' / 'help' lists the proxied commands; an unambiguous prefix (either
 * direction) returns the "Ambiguous — did you mean" hint; anything else gets a
 * platform-accurate parse error ('% Parse error at X' for aos,
 * 'Invalid input: X' for sw).
 */
export function terminalRespond(profile: Pick<DeviceProfile, 'kind'>, raw: string): TerminalLine[] | null {
  const cmd = raw.trim();
  const table = profile.kind === 'aos' ? AOS_TERMINAL_RESPONSES : SW_TERMINAL_RESPONSES;
  if (!cmd) return [];
  if (cmd === '?' || cmd === 'help') {
    return Object.keys(table).map((k) => ({ text: '  ' + k, tone: 'body' as const }));
  }
  if (cmd === 'clear') {
    return null;
  }
  const hit = Object.keys(table).find((k) => k === cmd);
  if (hit) return table[hit].map((t) => ({ text: t, tone: 'body' as const }));
  const near = Object.keys(table).find((k) => k.startsWith(cmd) || cmd.startsWith(k));
  if (near) return [{ text: 'Ambiguous — did you mean: ' + near, tone: 'warn' as const }];
  return [
    { text: (profile.kind === 'aos' ? '% Parse error at ' : 'Invalid input: ') + cmd, tone: 'warn' as const },
    { text: 'Type ? for the proxied command list.', tone: 'muted' as const },
  ];
}

// ---------------------------------------------------------------------------
// Path to the internet — NtClients pathFor()
// ---------------------------------------------------------------------------

/** Status-dot colours per hop tone (prototype `dot` map; 'info' falls back to neutral). */
const HOP_DOT: Partial<Record<PathHop['tone'], string>> = {
  success: 'var(--nd-success)',
  warning: 'var(--nd-warning)',
  danger: 'var(--nd-danger)',
  neutral: 'var(--nd-border-strong)',
  accent: 'var(--nd-accent)',
};
const NEUTRAL_DOT = 'var(--nd-border-strong)';

function decorateHops(hops: PathHop[]): PathHopView[] {
  return hops.map((h, i) => ({
    ...h,
    hasNext: i < hops.length - 1,
    plain: !h.device,
    dot: HOP_DOT[h.tone] ?? NEUTRAL_DOT,
  }));
}

/**
 * Compute the client's forwarding path as decorated hops.
 * Hop 0 is the client itself. VPN special case (plane 'AOS-10' + wireless +
 * attach 'gw-edge-1', and only when the chain has a gateway — otherwise it
 * falls through to the normal wireless path): residential broadband → gateway
 * → core → exit.
 * Wireless goes client → AP → (AOS-8: mc-lake-2 controller hop, tone danger,
 * GRE tunnel link) → access switch (skipped when it is the core) → core →
 * gateway (only when chain.gw is non-null) → exit. Wired starts at the access
 * switch. The AP switch-port is parsed from the closet string via
 * split('port ')[1]. Unknown sites fall back to the Campus-01 chain.
 */
export function pathFor(
  client: ClientRow,
  apUplink: ApUplinkMap = AP_UPLINK,
  siteChain: Partial<Record<SiteId, SiteChain>> = SITE_CHAIN,
): PathHopView[] {
  const chain = siteChain[client.siteId] ?? FALLBACK_CHAIN;
  const hops: PathHop[] = [];
  hops.push({ name: client.name, role: client.model + ' · ' + client.type, state: client.health, tone: client.healthTone, link: client.link + (client.rssi === '—' ? '' : ' · ' + client.rssi + ' · ' + client.tput), device: false });
  if (chain.gw && client.plane === 'AOS-10' && client.medium === 'wireless' && client.attach === 'gw-edge-1') {
    hops.push({ name: 'Residential broadband', role: 'untrusted internet', state: 'ok', tone: 'neutral', link: 'IPsec tunnel · rtt 28 ms · aes-gcm-256', device: false });
    hops.push({ name: chain.gw!, role: chain.gwRole!, state: chain.gwState!, tone: chain.gwTone!, link: 'transit vlan 12 · 10G to core', device: true });
    hops.push({ name: chain.core, role: chain.coreRole, state: chain.coreState, tone: chain.coreTone, link: chain.wan, device: true });
    hops.push({ name: chain.exit, role: chain.exitRole, state: 'ok', tone: 'neutral', link: null, device: false });
    return decorateHops(hops);
  }
  if (client.medium === 'wireless') {
    const uplink = apUplink[client.attach] || chain.core;
    const apPort = (client.closet || '').split('port ')[1];
    hops.push({ name: client.attach, role: client.plane === 'AOS-8' ? 'access point · tunnelled to controller' : 'access point · ' + client.plane.toLowerCase() + '-managed', state: 'up', tone: 'success', link: client.plane === 'AOS-8' ? 'GRE tunnel to mc-lake-2 · mtu 1500' : '1 Gb access port' + (apPort ? ' ' + apPort : '') + ' · vlan ' + client.vlan.replace('vlan ', ''), device: true });
    if (client.plane === 'AOS-8') {
      hops.push({ name: 'mc-lake-2', role: 'local controller · terminates the tunnel', state: 'no heartbeat', tone: 'danger', link: '10G uplink to core · client traffic still forwarding', device: true });
    } else if (uplink !== chain.core) {
      hops.push({ name: uplink, role: 'access switch · CX 6300M', state: 'up', tone: 'success', link: '20G lag to core · vlan trunk', device: true });
    }
  } else {
    hops.push({ name: client.attach, role: 'access switch · ' + client.where, state: 'up', tone: 'success', link: client.attach === chain.core ? chain.wan : '20G lag to core · vlan trunk', device: true });
  }
  if (client.attach !== chain.core) {
    hops.push({ name: chain.core, role: chain.coreRole, state: chain.coreState, tone: chain.coreTone, link: chain.gw ? 'transit vlan 12 · 10G to gateway' : chain.wan, device: true });
  }
  if (chain.gw) {
    hops.push({ name: chain.gw, role: chain.gwRole!, state: chain.gwState!, tone: chain.gwTone!, link: chain.wan, device: true });
  }
  hops.push({ name: chain.exit, role: chain.exitRole, state: 'ok', tone: 'neutral', link: null, device: false });
  return decorateHops(hops);
}

/** Session timeline variant by health string — the `tl` selection in renderVals. */
export function timelineFor(client: ClientRow): TimelineStep[] {
  return client.health === 'auth failing' ? TIMELINES.reject : client.health === 'no address' ? TIMELINES.dhcp : TIMELINES.default;
}

// ---------------------------------------------------------------------------
// Configure — NtConfigure renderVals() live previews
// ---------------------------------------------------------------------------

const OPMODE: Record<SsidSecurity, string> = {
  'wpa3-enterprise': 'wpa3-aes-ccm-128',
  'wpa2-enterprise': 'wpa2-aes-128',
  'psk-portal': 'wpa2-psk-aes',
  'wpa2-psk': 'wpa2-psk-aes',
  open: 'opensystem',
};

const BANDS: Record<SsidBands, string> = {
  '5+6': '5ghz 6ghz',
  all: '2.4ghz 5ghz 6ghz',
  '5': '5ghz',
};

/** "What gets pushed" for an SSID — the ssidPreview template, verbatim. */
export function ssidPreview(form: SsidForm): string {
  return 'wlan ssid-profile "' + form.name + '"\n    essid ' + form.name + '\n    opmode ' + OPMODE[form.security] + '\n    vlan ' + form.vlan +
    (form.security.indexOf('enterprise') > -1 ? '\n    dot1x-server-group clearpass' : '\n    wpa-passphrase vault://meridian/wlan/' + form.name.toLowerCase()) +
    '\n    band ' + BANDS[form.bands] + (form.broadcast ? '' : '\n    hide-ssid') + (form.isolate ? '\n    deny-inter-user-traffic' : '') +
    '\n!\nap-group "' + form.group + '"\n    virtual-ap "' + form.name + '"' + (form.noDfs ? '\n    rf-band-profile exclude-dfs' : '') +
    '\n!\n# central  → PUT /configuration/v2/wlan/' + form.group + '\n# mist     → read-only, opens in console with this payload\n# clearpass→ no change needed (radsec trust exists)';
}

/** "What gets pushed" for a switch port — the portPreview template, verbatim. */
export function portPreview(form: PortForm): string {
  return 'interface ' + form.id + '\n    description ' + form.desc + '\n    ' + (form.up ? 'no shutdown' : 'shutdown') +
    '\n    vlan ' + (form.mode === 'access' ? 'access ' + form.vlan : 'trunk native ' + form.vlan + '\n    vlan trunk allowed ' + form.vlan + ',820,816') +
    (form.poe ? '\n    power-over-ethernet allocate-by class' : '\n    no power-over-ethernet') +
    (form.dot1x ? '\n    aaa authentication port-access dot1x authenticator\n        enable' : '') +
    (form.mab ? '\n    aaa authentication port-access mac-auth\n        enable' : '') +
    '\n!\n# device   → ' + form.device + ' (local collector, recorded session)\n# rollback → snapshot taken before the push, one-click revert for 24h';
}

/** "What gets pushed" for a VLAN — the vlanPreview template, verbatim. */
export function vlanPreview(form: VlanForm): string {
  return 'vlan ' + form.id + '\n    name ' + form.name +
    form.helpers.split(',').map((h) => '\n    ip helper-address ' + h.trim()).join('') +
    '\n!\n# scope    → ' + form.scope + ' (' + (form.scope === 'cx-campus-01' ? '42 switches' : form.scope === 'cx-all' ? '96 switches' : '2 core switches') + ')\n# baseline → CX switch baseline expects two helpers' +
    (form.helpers.split(',').length > 1 ? ' — satisfied' : ' — still one, drift remains');
}

/** The prototype's preview dispatch: port → portPreview, vlan → vlanPreview, else ssidPreview. */
export function configPreviewFor(kind: 'ssid', form: SsidForm): string;
export function configPreviewFor(kind: 'port', form: PortForm): string;
export function configPreviewFor(kind: 'vlan', form: VlanForm): string;
export function configPreviewFor(kind: ConfigKind, form: ConfigForm): string {
  return kind === 'port' ? portPreview(form as PortForm) : kind === 'vlan' ? vlanPreview(form as VlanForm) : ssidPreview(form as SsidForm);
}

/** Mono meta note over the preview block — `previewMeta`. */
export function previewMetaFor(kind: 'ssid', form: SsidForm): string;
export function previewMetaFor(kind: 'port', form: PortForm): string;
export function previewMetaFor(kind: 'vlan', form: VlanForm): string;
export function previewMetaFor(kind: ConfigKind, form: ConfigForm): string {
  return kind === 'ssid'
    ? ((form as SsidForm).plane || 'CENTRAL') + ' · RENDERED PER PLANE'
    : kind === 'port'
      ? (form as PortForm).device.toUpperCase() + ' · CX CLI'
      : (form as VlanForm).scope.toUpperCase() + ' · CX CLI';
}

/** Blast-radius rows under the preview — the `radius` arrays, verbatim. */
export function blastRadiusFor(kind: 'ssid', form: SsidForm): BlastRadiusRow[];
export function blastRadiusFor(kind: 'port', form: PortForm): BlastRadiusRow[];
export function blastRadiusFor(kind: 'vlan', form: VlanForm): BlastRadiusRow[];
export function blastRadiusFor(kind: ConfigKind, form: ConfigForm): BlastRadiusRow[] {
  if (kind === 'ssid') {
    const f = form as SsidForm;
    return [
      { what: 'Access points that reload the profile', count: f.group === 'all-sites' ? '268' : f.group === 'clinical-floors' ? '268' : f.group === 'staff-wireless' ? '96' : '44' },
      { what: 'Client sessions that will re-authenticate', count: '2,472' },
      { what: 'Planes touched', count: f.plane || 'CENTRAL' },
    ];
  }
  if (kind === 'port') {
    const f = form as PortForm;
    return [
      { what: 'Interfaces changed', count: '1' },
      { what: 'Clients on this port right now', count: f.id === '1/1/14' ? '1 (ap-3f-12, 38 wireless clients behind it)' : '1' },
      { what: 'Rollback snapshot', count: 'taken before push' },
    ];
  }
  const f = form as VlanForm;
  return [
    { what: 'Switches in scope', count: f.scope === 'cx-all' ? '96' : f.scope === 'core-only' ? '2' : '42' },
    { what: 'Clients on this VLAN', count: f.id === '812' ? '1,842 leases' : 'n/a' },
    { what: 'Compliance findings resolved', count: f.helpers.split(',').length > 1 ? '1' : '0' },
  ];
}

/**
 * Form seeding when an Edit row opens — the `edit:` patches in renderVals.
 * Returns a partial form to merge over the current form state (fields not
 * mentioned keep their current values, exactly as in the prototype).
 */
export function seedFormFromRow(kind: 'ssid', row: SsidObject): Partial<SsidForm>;
export function seedFormFromRow(kind: 'port', row: PortObject): Partial<PortForm>;
export function seedFormFromRow(kind: 'vlan', row: VlanObject): Partial<VlanForm>;
export function seedFormFromRow(kind: ConfigKind, row: SsidObject | PortObject | VlanObject): Partial<ConfigForm> {
  if (kind === 'ssid') {
    const w = row as SsidObject;
    return { name: w.name, vlan: w.vlan.replace('vlan ', ''), plane: w.plane };
  }
  if (kind === 'port') {
    const p = row as PortObject;
    return {
      device: p.device,
      id: p.port,
      desc: p.desc,
      vlan: (p.summary.split('vlan ')[1] || '812').split(' ')[0],
      poe: p.summary.indexOf('poe') > -1 && p.summary.indexOf('no poe') < 0,
      mab: p.summary.indexOf('MAB') > -1,
      dot1x: p.summary.indexOf('802.1X') > -1,
      up: p.state !== 'down',
    };
  }
  const v = row as VlanObject;
  return { id: v.id, name: v.name, helpers: v.id === '812' ? '10.42.0.20' : '10.42.0.20, 10.44.0.20' };
}

// ---------------------------------------------------------------------------
// Site topology — SiteDetail layered wiring diagram
// ---------------------------------------------------------------------------

/**
 * Build the site's layered topology (WAN side on top, edge at the bottom)
 * from data the portal actually holds: the recorded forwarding chain
 * (SITE_CHAIN), the AP → access-switch uplink map (AP_UPLINK), and the site
 * profile's device rows. Nothing is invented: edges carry a label only where
 * the data carries one (chain.wan, and 'vsx pair' when both roles say vsx),
 * APs without a recorded uplink get an edge only when the site has exactly
 * one candidate parent (safe inference), and devices with no parent sit in
 * their layer unconnected — the note says so.
 *
 * APs sharing one parent collapse into a single group chip ('3 APs', worst
 * member tone) — the diagram opens collapsed; the screen expands a chip in
 * place. Layers with no nodes are omitted from `layers`.
 */
export function buildSiteTopology(
  siteId: SiteId | null,
  devices: SiteDeviceRow[],
  chain: SiteChain | null,
  apUplink: ApUplinkMap = AP_UPLINK,
): SiteTopology {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const byName = new Map(devices.map((d) => [d.name, d]));

  // -- chain nodes (wan / gateway / core anchors) ----------------------------
  let coreId: string | null = null;
  let gwId: string | null = null;
  if (chain) {
    const exitId = 'exit';
    nodes.push({ id: exitId, layer: 'wan', label: chain.exit, sub: chain.exitRole, state: 'ok', tone: 'neutral', device: null, members: null });
    if (chain.gw) {
      gwId = `dev:${chain.gw}`;
      nodes.push({ id: gwId, layer: 'gateway', label: chain.gw, sub: chain.gwRole ?? '', state: chain.gwState ?? 'unknown', tone: chain.gwTone ?? 'neutral', device: byName.has(chain.gw) ? chain.gw : null, members: null });
    }
    coreId = `dev:${chain.core}`;
    nodes.push({ id: coreId, layer: 'core', label: chain.core, sub: chain.coreRole, state: chain.coreState, tone: chain.coreTone, device: byName.has(chain.core) ? chain.core : null, members: null });
    edges.push({ from: exitId, to: gwId ?? coreId, label: chain.wan });
    if (gwId) edges.push({ from: gwId, to: coreId, label: null });
  }

  // -- classify the site's device rows ---------------------------------------
  type Classed = { row: SiteDeviceRow; cls: 'gateway' | 'core' | 'ap' | 'controller' | 'leaf' | 'access' };
  const classed: Classed[] = [];
  for (const row of devices) {
    if (chain && (row.name === chain.core || row.name === chain.gw)) continue; // already chain nodes
    const role = row.role.toLowerCase();
    const cls: Classed['cls'] =
      row.name.startsWith('ap-')
        ? 'ap'
        : role.includes('gateway')
          ? 'gateway'
          : role.includes('core') || role.includes('stack master')
            ? 'core'
            : role.includes('controller') || role.includes('mobility master') || role === 'local'
              ? 'controller'
              : role.includes('sensor') || role.includes('policy')
                ? 'leaf'
                : 'access';
    classed.push({ row, cls });
  }

  // No chain: the first core-classified device anchors the parents (if any).
  if (!chain) {
    const anchor = classed.find((c) => c.cls === 'core');
    if (anchor) coreId = `dev:${anchor.row.name}`;
  }

  const deviceNode = (row: SiteDeviceRow, layer: TopologyLayerKey): TopologyNode => ({
    id: `dev:${row.name}`,
    layer,
    label: row.name,
    sub: row.role,
    state: row.state,
    tone: row.stateTone,
    device: row.name,
    members: null,
  });

  for (const c of classed.filter((c) => c.cls === 'gateway')) {
    nodes.push(deviceNode(c.row, 'gateway'));
    if (coreId) edges.push({ from: `dev:${c.row.name}`, to: coreId, label: null });
  }
  for (const c of classed.filter((c) => c.cls === 'core')) {
    nodes.push(deviceNode(c.row, 'core'));
    if (coreId && `dev:${c.row.name}` !== coreId) {
      // VSX peers name themselves in the role ('core / vsx-1' ↔ 'vsx-2').
      const anchorRow = byName.get(coreId.slice(4));
      const vsx = c.row.role.toLowerCase().includes('vsx') && (anchorRow?.role.toLowerCase().includes('vsx') ?? false);
      edges.push({ from: `dev:${c.row.name}`, to: coreId, label: vsx ? 'vsx pair' : null });
    }
  }
  const accessNodes = classed.filter((c) => c.cls === 'access');
  for (const c of accessNodes) {
    nodes.push(deviceNode(c.row, 'access'));
    if (coreId) edges.push({ from: `dev:${c.row.name}`, to: coreId, label: null });
  }
  for (const c of classed.filter((c) => c.cls === 'controller')) {
    nodes.push(deviceNode(c.row, 'edge'));
    if (coreId) edges.push({ from: `dev:${c.row.name}`, to: coreId, label: null });
  }
  for (const c of classed.filter((c) => c.cls === 'leaf')) {
    nodes.push(deviceNode(c.row, 'edge'));
  }

  // -- APs: collapse per parent switch ----------------------------------------
  const accessNames = accessNodes.map((c) => c.row.name);
  const aps = classed.filter((c) => c.cls === 'ap');
  const parentFor = (name: string): string | null => {
    const recorded = apUplink[name];
    if (recorded && (byName.has(recorded) || accessNames.includes(recorded))) return recorded;
    if (!recorded && accessNames.length === 1) return accessNames[0]; // single-parent site — safe inference
    return null; // no recorded uplink — sits unconnected, the note says so
  };
  const apByParent = new Map<string, SiteDeviceRow[]>();
  const apSingles: SiteDeviceRow[] = [];
  for (const c of aps) {
    const parent = parentFor(c.row.name);
    if (parent === null) {
      apSingles.push(c.row);
      continue;
    }
    const list = apByParent.get(parent) ?? [];
    list.push(c.row);
    apByParent.set(parent, list);
  }
  for (const [parent, rows] of [...apByParent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const parentId = `dev:${parent}`;
    if (rows.length === 1) {
      nodes.push(deviceNode(rows[0], 'edge'));
      edges.push({ from: parentId, to: `dev:${rows[0].name}`, label: null });
      continue;
    }
    const worst = rows.reduce((w, r) => (toneRank(r.stateTone) < toneRank(w) ? r.stateTone : w), 'success' as Tone);
    const id = `grp:${parent}:ap`;
    nodes.push({
      id,
      layer: 'edge',
      label: `${rows.length} APs`,
      sub: `on ${parent}`,
      state: rows.some((r) => r.stateTone === 'danger') ? 'degraded' : 'up',
      tone: worst,
      device: null,
      members: rows.map((r) => ({ name: r.name, state: r.state, tone: r.stateTone })),
    });
    edges.push({ from: parentId, to: id, label: null });
  }
  for (const row of apSingles.sort((a, b) => a.name.localeCompare(b.name))) {
    nodes.push(deviceNode(row, 'edge'));
  }

  // -- assemble ----------------------------------------------------------------
  const order: TopologyLayerKey[] = ['wan', 'gateway', 'core', 'access', 'edge'];
  const byLabel = (a: TopologyNode, b: TopologyNode): number => a.label.localeCompare(b.label);
  const sorted = order.flatMap((layer) => nodes.filter((n) => n.layer === layer).sort(byLabel));
  const layers = order.filter((layer) => sorted.some((n) => n.layer === layer));
  const nodeIds = new Set(sorted.map((n) => n.id));
  const liveEdges = edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  const note = chain
    ? 'wiring from recorded uplink and chain data · nodes without edges have no recorded uplink'
    : 'no forwarding-chain record for this site — device layers only, no uplink edges beyond recorded data';
  void siteId; // reserved for per-site overrides; layers are device-driven today
  return { layers, nodes: sorted, edges: liveEdges, note };
}

/** Lower rank = worse tone (for group roll-ups). */
function toneRank(t: Tone): number {
  switch (t) {
    case 'danger':
      return 0;
    case 'warning':
      return 1;
    case 'neutral':
      return 2;
    case 'info':
      return 3;
    case 'accent':
      return 4;
    case 'success':
      return 5;
    default:
      return 2;
  }
}
