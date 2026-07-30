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
  DeviceRow,
  DeviceType,
  DetailFetchState,
  DetailSource,
  PathHop,
  PathHopView,
  Plane,
  PlaneDatasetKey,
  PlaneFreshness,
  PlaneHealthKey,
  PlaneKey,
  PlaneScope,
  PlaneStaleness,
  PortForm,
  PortObject,
  Sev,
  SiteChain,
  SiteDeviceRow,
  SiteId,
  SiteTopology,
  SsidBands,
  SsidDependencyRequirement,
  SsidForm,
  SsidObject,
  SsidSecurity,
  SyncOutcome,
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
  PLANE_KEY_BY_LABEL,
  PLANE_WRITE_MODE,
  SITE_CHAIN,
  SW_TERMINAL_RESPONSES,
  TIMELINES,
  UNKNOWN_LANE_META,
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

/**
 * Terminal class for a device the portal actually holds a row for. The
 * name-prefix rules in deviceProfile() are a DEMO convention: a real tenant
 * names a Mist AP 'AP-Floor3' or 'Office-AP-12', which no lowercase 'ap-'
 * prefix matches — the bridge would then classify a cloud-claimed radio as a
 * CX switch and try to log into it. The inventory row knows better:
 *   ap / sensor          → 'none' (cloud-claimed, no portal shell)
 *   gateway / controller → 'aos'
 *   switch / policy      → 'sw'
 * Pass `null` (no live row — demo estate) to fall back to the prefix rules.
 */
export function deviceTerminalKind(
  row: { type: DeviceType } | null | undefined,
  fallbackName: string,
): TerminalKind {
  if (!row) return deviceProfile(fallbackName).kind;
  if (row.type === 'ap' || row.type === 'sensor') return 'none';
  if (row.type === 'gateway' || row.type === 'controller') return 'aos';
  return 'sw';
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

/**
 * What a security mode requires before a direct SSID apply can be enabled —
 * derived from SsidSecurity alone so the editor and the server-side validator
 * agree without duplicating the rule. A role is required by every mode (New
 * Central assigns one on every WLAN); enterprise modes additionally need a
 * live authentication server group, portal needs a live captive-portal
 * profile, and
 * PSK/portal modes need a passphrase. Open omits credentials but still needs
 * the role.
 */
export function ssidDependencyRequirementsFor(security: SsidSecurity): SsidDependencyRequirement {
  return {
    role: true,
    authServerGroup: security === 'wpa3-enterprise' || security === 'wpa2-enterprise',
    captivePortal: security === 'psk-portal',
    passphrase: security === 'wpa2-psk' || security === 'psk-portal',
  };
}

/**
 * Deployment-specific parts of the SSID preview. Every field is optional and
 * every default reproduces the authored demo estate byte-for-byte, so demo
 * output (and the prototype-fidelity tests) are unchanged.
 *
 * Live callers pass these so the payload stops naming the fixture estate:
 * `vault://meridian/...` is Meridian Health's secret store, `clearpass` is the
 * demo server group, and the three trailing comment lines describe the demo's
 * plane set. README:288-290 requires the live block to carry the API call per
 * plane — that is what `planeNotes` is for, rather than stripping every '#'
 * line and losing the annotation entirely.
 */
export interface SsidPreviewOptions {
  /** Rendered after `wpa-passphrase` for PSK/portal modes. Default: the demo
   *  estate's vault path. Pass the deployment's own secret reference (or a
   *  'set in the plane console' placeholder) in live mode. */
  passphraseRef?: string;
  /** Rendered after `dot1x-server-group` for enterprise modes. Default:
   *  'clearpass' — which is a lie when no ClearPass plane is linked. */
  dot1xGroup?: string;
  /** Trailing annotation lines, WITHOUT the leading '# '. Default: the demo's
   *  three plane lines. Pass `[]` to omit annotations entirely. */
  planeNotes?: string[];
}

/** The demo estate's authored annotation block (README's per-plane comments). */
function demoSsidPlaneNotes(form: SsidForm): string[] {
  return [
    'central  → PUT /configuration/v2/wlan/' + form.group,
    'mist     → read-only, opens in console with this payload',
    'clearpass→ no change needed (radsec trust exists)',
  ];
}

/** "What gets pushed" for an SSID — the ssidPreview template, verbatim. */
export function ssidPreview(form: SsidForm, opts: SsidPreviewOptions = {}): string {
  const passphraseRef = opts.passphraseRef ?? 'vault://meridian/wlan/' + form.name.toLowerCase();
  const dot1xGroup = opts.dot1xGroup ?? 'clearpass';
  const notes = opts.planeNotes ?? demoSsidPlaneNotes(form);
  const annotations = notes.length > 0 ? '\n' + notes.map((n) => '# ' + n).join('\n') : '';
  return 'wlan ssid-profile "' + form.name + '"\n    essid ' + form.name + '\n    opmode ' + OPMODE[form.security] + '\n    vlan ' + form.vlan +
    (form.security.indexOf('enterprise') > -1 ? '\n    dot1x-server-group ' + dot1xGroup : '\n    wpa-passphrase ' + passphraseRef) +
    '\n    band ' + BANDS[form.bands] + (form.broadcast ? '' : '\n    hide-ssid') + (form.isolate ? '\n    deny-inter-user-traffic' : '') +
    '\n!\nap-group "' + form.group + '"\n    virtual-ap "' + form.name + '"' + (form.noDfs ? '\n    rf-band-profile exclude-dfs' : '') +
    '\n!' + annotations;
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
export function configPreviewFor(kind: 'ssid', form: SsidForm, opts?: SsidPreviewOptions): string;
export function configPreviewFor(kind: 'port', form: PortForm): string;
export function configPreviewFor(kind: 'vlan', form: VlanForm): string;
export function configPreviewFor(kind: ConfigKind, form: ConfigForm, opts: SsidPreviewOptions = {}): string {
  return kind === 'port' ? portPreview(form as PortForm) : kind === 'vlan' ? vlanPreview(form as VlanForm) : ssidPreview(form as SsidForm, opts);
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

/** Seeding options — `live` drops the prototype's authored fallbacks so a real
 *  row never inherits fixture values the plane did not report. */
export interface SeedFormOptions {
  live?: boolean;
}

/**
 * Form seeding when an Edit row opens — the `edit:` patches in renderVals.
 * Returns a partial form to merge over the current form state (fields not
 * mentioned keep their current values, exactly as in the prototype).
 *
 * In demo mode the authored fallbacks are part of the fixture (VLAN '812' for
 * a port whose summary carries no vlan token, the Meridian DHCP helpers for a
 * VLAN row). Pass `{ live: true }` for a row read back off a real plane: the
 * unknown fields come back empty so nothing fictional can reach a push
 * preview or the write broker.
 */
export function seedFormFromRow(kind: 'ssid', row: SsidObject, opts?: SeedFormOptions): Partial<SsidForm>;
export function seedFormFromRow(kind: 'port', row: PortObject, opts?: SeedFormOptions): Partial<PortForm>;
export function seedFormFromRow(kind: 'vlan', row: VlanObject, opts?: SeedFormOptions): Partial<VlanForm>;
export function seedFormFromRow(
  kind: ConfigKind,
  row: SsidObject | PortObject | VlanObject,
  opts: SeedFormOptions = {},
): Partial<ConfigForm> {
  if (kind === 'ssid') {
    const w = row as SsidObject;
    return { name: w.name, vlan: w.vlan.replace('vlan ', ''), plane: w.plane };
  }
  if (kind === 'port') {
    const p = row as PortObject;
    return {
      device: p.device,
      plane: p.plane,
      serial: p.serial,
      id: p.port,
      desc: p.desc,
      vlan: (p.summary.split('vlan ')[1] || (opts.live ? '' : '812')).split(' ')[0],
      poe: p.summary.indexOf('poe') > -1 && p.summary.indexOf('no poe') < 0,
      mab: p.summary.indexOf('MAB') > -1,
      dot1x: p.summary.indexOf('802.1X') > -1,
      up: p.state !== 'down',
    };
  }
  const v = row as VlanObject;
  return {
    id: v.id,
    name: v.name,
    helpers: opts.live ? '' : v.id === '812' ? '10.42.0.20' : '10.42.0.20, 10.44.0.20',
  };
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

// ---------------------------------------------------------------------------
// Freshness, ages and sync outcomes — README design rule 1
// ---------------------------------------------------------------------------

/**
 * Compact relative age in the fixtures' own vocabulary ('40s', '12m', '6h',
 * '3d'), '—' when there is no timestamp to age from. Same shape the authored
 * rows use, so a live row and a demo row read identically.
 */
export function relativeAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** SLA window per severity — the table the ticket raiser already applies. */
export const SLA_HOURS: Record<Sev, number> = { P1: 4, P2: 8, P3: 24 };

/**
 * Live SLA line for a ticket: 'SLA breach in 1h 12m' while there is time left,
 * 'SLA breached 40m ago' once the deadline has passed. Returns null when the
 * ticket carries no deadline (the authored fixtures) so the caller keeps the
 * authored string instead of inventing a countdown.
 */
export function slaCountdown(dueAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!dueAt) return null;
  const due = new Date(dueAt).getTime();
  if (!Number.isFinite(due)) return null;
  const min = Math.round(Math.abs(due - now) / 60_000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  const span = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return due >= now ? `SLA breach in ${span}` : `SLA breached ${span} ago`;
}

/**
 * Age a plane's last successful sync and decide whether it has expired.
 * A plane that has never synced is stale by definition — its devices must
 * read `unverified`, never `up` (design rule 1). `staleAfterSec` is the
 * window the caller considers current, typically a few poll intervals.
 */
export function planeFreshness(
  lastSync: string | null,
  staleAfterSec: number,
  now: number = Date.now(),
): PlaneFreshness {
  if (!lastSync) return { lastSync: null, ageSec: null, stale: true };
  const ts = new Date(lastSync).getTime();
  if (!Number.isFinite(ts)) return { lastSync, ageSec: null, stale: true };
  const ageSec = Math.max(0, Math.round((now - ts) / 1000));
  return { lastSync, ageSec, stale: ageSec > staleAfterSec };
}

/**
 * Poll intervals a plane may miss before its last sync reads stale, and the
 * floor that keeps a very short interval from marking a plane stale during a
 * single slow pull. The registry, the poller and the screen endpoints must all
 * expire a plane at the same age — otherwise one screen renders `up` while
 * another renders `unverified` from the same PlaneState.
 */
export const STALE_AFTER_INTERVALS = 3;
export const STALE_AFTER_FLOOR_SEC = 90;

/** The staleness window for a given poll interval — the ONE definition. */
export function staleAfterSecFor(pollIntervalSec: number): number {
  const interval = Number.isFinite(pollIntervalSec) ? pollIntervalSec : 0;
  return Math.max(STALE_AFTER_FLOOR_SEC, STALE_AFTER_INTERVALS * Math.max(0, interval));
}

/**
 * Age-based staleness for one plane, with the reason. This is what a consumer
 * needs instead of keying on `health === 'degraded'`: a plane whose poller
 * quietly stopped still reports 'healthy' with an hour-old lastSync, and its
 * rows must read `unverified` (design rule 1).
 *
 * An unlinked plane is never "stale" — it contributes no rows to be stale.
 * A linked plane that has never synced IS stale: there is nothing to present.
 * `warning` (a partial pull: some datasets unread) is stale-with-reason
 * 'partial', so a half-read Central cannot render its devices as verified.
 */
export function planeStaleness(
  plane: { linked: boolean; health: PlaneHealthKey; lastSync: string | null },
  staleAfterSec: number,
  now: number = Date.now(),
): PlaneStaleness {
  const fresh = planeFreshness(plane.lastSync, staleAfterSec, now);
  if (!plane.linked || plane.health === 'unlinked') {
    return { ...fresh, stale: false, reason: null };
  }
  if (plane.health === 'degraded') return { ...fresh, stale: true, reason: 'degraded' };
  if (fresh.lastSync === null) return { ...fresh, stale: true, reason: 'never-synced' };
  if (fresh.stale) return { ...fresh, reason: 'aged-out' };
  if (plane.health === 'warning') return { ...fresh, stale: true, reason: 'partial' };
  return { ...fresh, reason: null };
}

/**
 * The lane header's sync stamp, in the fixtures' own vocabulary, so a live
 * lane and a demo lane read identically:
 *   a stamp        → 'synced 40s'
 *   null (linked)  → 'never synced'
 *   undefined      → the non-asserting UNKNOWN_LANE_META.sync
 * It never invents a stamp, and never says "linked".
 */
export function laneSyncStamp(lastSync: string | null | undefined, now: number = Date.now()): string {
  if (lastSync === undefined) return UNKNOWN_LANE_META.sync;
  if (lastSync === null) return 'never synced';
  return `synced ${relativeAge(lastSync, now)}`;
}

/**
 * Classify one pull so the registry can stamp what actually happened rather
 * than a binary ok/fail. The case the honesty rules exist for is `empty`: the
 * plane answered and reported nothing, which must not be recorded as a
 * healthy sync carrying data, nor be presented as an authoritative zero.
 */
export function syncOutcomeFor(pull: {
  ok: boolean;
  reported: readonly PlaneDatasetKey[];
  missing?: readonly PlaneDatasetKey[];
  rows: number;
}): SyncOutcome {
  if (!pull.ok) return 'failed';
  if (pull.missing && pull.missing.length > 0) return 'partial';
  if (pull.reported.length === 0 || pull.rows === 0) return 'empty';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Device identity — the inventory row is authoritative over the profile
// ---------------------------------------------------------------------------

/**
 * Overlay the reconciled inventory row's identity onto a name-prefix device
 * profile, so a detail page can never contradict the row that linked to it
 * (README:239-241: the header is `state Badge, plane Badge, model · site · IP`
 * for THAT device). Only identity fields the row actually carries are
 * overridden — `ip`, `prompt`, `stats`, `ports` and `checks` stay as authored
 * unless the row supplies a better value.
 */
export function applyDeviceRowToProfile(profile: DeviceProfile, row: DeviceRow | null | undefined): DeviceProfile {
  if (!row) return profile;
  return {
    ...profile,
    model: row.model || profile.model,
    site: row.siteName || profile.site,
    siteId: row.siteId ?? profile.siteId,
    ip: row.ip || profile.ip,
    plane: row.plane,
    planeTone: row.planeTone,
    state: row.state,
    stateTone: row.stateTone,
  };
}

// ---------------------------------------------------------------------------
// Write model — one source for the capability matrix and the scope badge
// ---------------------------------------------------------------------------

/**
 * The scope badge for a plane, derived from what the broker can actually do
 * (PLANE_WRITE_MODE), what the operator granted, and — for a plane whose only
 * write path is a reviewed direct mutation — what the adapter itself claims.
 * An unlinked plane, or a brokered plane without a write scope, is honestly
 * `read only`.
 */
export function scopeForPlane(
  plane: PlaneKey,
  opts: { linked: boolean; scopes?: string | null; directWrite?: boolean } = { linked: false },
): PlaneScope {
  if (!opts.linked) return 'read only';
  const mode = PLANE_WRITE_MODE[plane];
  if (mode === 'ssh') return 'read + ssh';
  if (mode === 'brokered' && (opts.scopes ?? '').includes('write')) return 'read + broker';
  // A plane with no broker and no shell can still take a REVIEWED DIRECT
  // write — SSE's object CRUD + tenant-wide Commit is the only one today.
  // That path is claimed by the adapter through capabilities().directWrite,
  // and the caller must pass it explicitly: the Configure screen's
  // port/SSID/VLAN matrix deliberately does NOT, because SSE never
  // participates in it, while the Systems badge does. Both the operator's
  // grant and the adapter's claim are required, so this can never advertise
  // a write path that was not granted.
  if (mode === 'read only' && opts.directWrite === true && (opts.scopes ?? '').includes('write')) {
    return 'read + direct';
  }
  return 'read only';
}

// ---------------------------------------------------------------------------
// Detail-read provenance — three states, and field-level support
// ---------------------------------------------------------------------------

/**
 * What happened to one section of a detail read.
 *
 * A section key the adapter never set was never attempted, which is exactly
 * 'not-fetched' — so read through this instead of indexing `sections` directly
 * and letting `undefined` leak into a render.
 */
export function detailState<S extends string>(
  source: DetailSource<S> | null | undefined,
  section: S,
): DetailFetchState {
  return source?.sections?.[section] ?? 'not-fetched';
}

/**
 * Did this section come back with real rows?
 *
 * Deliberately NOT `rows.length > 0`: a section can be 'ok' with rows, 'empty'
 * (the plane genuinely has none), 'failed' (the call broke) or 'not-fetched'
 * (we never asked), and the last three render three different sentences.
 */
export function detailHasRows<S extends string>(
  source: DetailSource<S> | null | undefined,
  section: S,
  rows: unknown[] | undefined,
): boolean {
  return detailState(source, section) === 'ok' && Array.isArray(rows) && rows.length > 0;
}

/** The client fields the drawer states provenance for. An explicit list, not
 *  `keyof Client`: widening a keyof-indexed type has broken this codebase
 *  before, and only these are actually reasoned about. */
export const CLIENT_PROVENANCE_FIELDS = [
  'rssi',
  'snr',
  'retries',
  'tput',
  'roams',
  'quality',
  'zone',
  'group',
  'closet',
  'vlan',
  'ip',
  'link',
  'where',
  'attach',
  'role',
  'auth',
  'session',
  'health',
] as const;
export type ClientProvenanceField = (typeof CLIENT_PROVENANCE_FIELDS)[number];

/**
 * Fields a plane HAS NO CONCEPT OF, with the honest sentence to say instead.
 *
 * This is an assertion about the plane's data model, so it may only name a
 * plane/field pair that has actually been checked against the published spec.
 * A plane absent from this table asserts nothing: every field is treated as
 * supported, which keeps the existing "not reported by X" wording — the safe
 * default, because claiming a plane lacks a concept it has is its own lie.
 *
 * CENTRAL, verified against the published Client schema (authenticationType …
 * wlanName): there is siteId/siteName and NOTHING ELSE placing a client.
 * There is no zone and no per-client config group. Aruba Central's construct
 * is the SITE — do not invent a zone lookup for it.
 */
const CLIENT_FIELD_UNSUPPORTED: Partial<
  Record<PlaneKey, Partial<Record<ClientProvenanceField, string>>>
> = {
  central: {
    zone: 'Central places clients by site, not zone',
    group: 'Central places clients by site — a client carries no config group',
  },
};

/** Normalize either spelling of a plane (display label 'CENTRAL' or registry
 *  key 'central') to the key. null = not a plane the portal adapts. */
export function planeKeyOf(plane: PlaneKey | Plane | null | undefined): PlaneKey | null {
  if (!plane) return null;
  if (plane in PLANE_KEY_BY_LABEL) return PLANE_KEY_BY_LABEL[plane as Plane];
  return PLANE_WRITE_MODE[plane as PlaneKey] ? (plane as PlaneKey) : null;
}

/**
 * Does this plane MODEL this client field at all?
 *
 * false = the plane has no such concept, so a renderer must say that (or omit
 * the row) — never "not reported by CENTRAL", which blames the plane for a
 * field it never had. true = the plane models it, so an absent value really is
 * "not reported this poll".
 *
 * NOTE FOR RENDERERS: this describes a LIVE plane's data model. The demo
 * fixtures are authored and complete; gate any provenation on the section
 * being live, or demo parity breaks (a fixture CENTRAL client has an authored
 * zone, and it must keep rendering).
 */
export function planeSupportsClientField(
  plane: PlaneKey | Plane | null | undefined,
  field: ClientProvenanceField,
): boolean {
  const key = planeKeyOf(plane);
  if (!key) return true; // nothing checked = assert nothing
  return CLIENT_FIELD_UNSUPPORTED[key]?.[field] === undefined;
}

/**
 * Why a client field is blank, in the three flavours the honesty rules need:
 *   present     — there is a value; render it
 *   unsupported — the plane has no such concept; say so or omit the row
 *   missing     — the plane models it but did not report it this poll
 */
export type ClientFieldProvenance =
  | { kind: 'present' }
  | { kind: 'unsupported'; note: string }
  | { kind: 'missing'; note: string };

/** Values the fixtures and adapters use for "nothing here". */
function isBlankValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === '—';
}

/**
 * One decision point for the client drawer's blank rows, so five renderers
 * cannot invent five different sentences for the same situation.
 */
export function clientFieldProvenance(
  plane: PlaneKey | Plane | null | undefined,
  field: ClientProvenanceField,
  value: unknown,
): ClientFieldProvenance {
  if (!isBlankValue(value)) return { kind: 'present' };
  const key = planeKeyOf(plane);
  const unsupported = key ? CLIENT_FIELD_UNSUPPORTED[key]?.[field] : undefined;
  if (unsupported) return { kind: 'unsupported', note: unsupported };
  const label = key ? PLANE_LABEL_BY_KEY[key] : null;
  return { kind: 'missing', note: label ? `not reported by ${label}` : 'not reported' };
}

/** Registry key -> display label. Derived from PLANE_KEY_BY_LABEL so the two
 *  directions can never drift. */
const PLANE_LABEL_BY_KEY: Partial<Record<PlaneKey, Plane>> = Object.fromEntries(
  (Object.entries(PLANE_KEY_BY_LABEL) as [Plane, PlaneKey | null][])
    .filter((entry): entry is [Plane, PlaneKey] => entry[1] !== null)
    .map(([label, key]) => [key, label]),
) as Partial<Record<PlaneKey, Plane>>;

// ---------------------------------------------------------------------------
// Serving-radio join — the fields Central models per RADIO, not per client
// ---------------------------------------------------------------------------

/**
 * RSSI in dBm, DERIVED from the client's SNR and its serving radio's noise
 * floor: RSSI = SNR + noise floor (both dB, the noise floor negative, so
 * 48 + -97 = -49 dBm).
 *
 * THIS NUMBER IS NOT REPORTED BY THE PLANE. Central's Client schema has no
 * rssi field at all — the only per-client rssi in the whole Monitoring spec is
 * MobilityDetails.rssi, a ROAM EVENT row, which a stationary client never
 * produces. So this is arithmetic on two reported values, and a renderer must
 * label it as derived in one short line, never present it as a plane reading.
 *
 * A missing input yields null, NEVER 0 and never a guess: with no noise floor
 * there is no RSSI, and 0 dBm is a real (and absurd) signal level. Inputs are
 * accepted as `undefined` too so callers can pass an unset optional straight
 * through without laundering it into a number.
 */
export function deriveRssiDbm(
  snrDb: number | null | undefined,
  noiseFloorDbm: number | null | undefined,
): number | null {
  if (typeof snrDb !== 'number' || !Number.isFinite(snrDb)) return null;
  if (typeof noiseFloorDbm !== 'number' || !Number.isFinite(noiseFloorDbm)) return null;
  return snrDb + noiseFloorDbm;
}

/** The minimum a radio row must carry to be matched — DeviceRadio satisfies it
 *  structurally, and so does a test stub. */
export interface RadioBandChannel {
  /** '2.4 GHz' | '5 GHz' | '6 GHz', as the plane words it. */
  band: string;
  /** Channel as the plane words it — '6', '40E', '157E'. */
  channel: string;
}

/** '2.4 GHz' -> '2.4', '5 GHz' -> '5'. null when there is no number to key on. */
function bandKey(band: string | null | undefined): string | null {
  const m = /(\d+(?:\.\d+)?)/.exec(band ?? '');
  return m ? m[1] : null;
}

/**
 * The channel NUMBER, dropping every way the two sides decorate it: Central's
 * client says '6 (20 MHz)', its radio says '6', and 5 GHz radios carry a width
 * marker ('40E', '157E', '213S'). null when there is no leading number.
 */
function channelKey(channel: string | null | undefined): string | null {
  const m = /^\s*(\d+)/.exec(channel ?? '');
  return m ? String(Number(m[1])) : null;
}

/**
 * The radio a client is actually being served by, out of its AP's radio list.
 *
 * Match order:
 *   1. band AND channel — the real answer.
 *   2. band alone, but ONLY when exactly one radio serves that band: an AP has
 *      one 2.4 GHz radio, so "the 2.4 GHz radio" is unambiguous even if the
 *      channel moved between the two reads.
 *   3. channel alone, same uniqueness rule, for the case where the client row
 *      carries no band.
 * Anything ambiguous returns null. A wrong radio would put another radio's
 * retries and noise floor on this client's drawer, which is worse than the
 * blank row it replaces — so this guesses at nothing.
 */
export function matchServingRadio<R extends RadioBandChannel>(
  radios: readonly R[] | null | undefined,
  band: string | null | undefined,
  channel: string | null | undefined,
): R | null {
  if (!Array.isArray(radios) || radios.length === 0) return null;
  const wantBand = bandKey(band);
  const wantChannel = channelKey(channel);

  if (wantBand) {
    const byBand = radios.filter((r) => bandKey(r.band) === wantBand);
    if (wantChannel) {
      const exact = byBand.filter((r) => channelKey(r.channel) === wantChannel);
      if (exact.length === 1) return exact[0];
    }
    return byBand.length === 1 ? byBand[0] : null;
  }

  if (wantChannel) {
    const byChannel = radios.filter((r) => channelKey(r.channel) === wantChannel);
    return byChannel.length === 1 ? byChannel[0] : null;
  }

  return null;
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
