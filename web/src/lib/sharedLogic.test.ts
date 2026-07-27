/**
 * sharedLogic.test.ts — pure-data unit tests for the shared/logic.ts helpers
 * the web app renders: Configure previews (configPreviewFor / previewMetaFor /
 * blastRadiusFor), the client session timeline (timelineFor), and the device
 * terminal behaviour (deviceProfile / terminalBanner / terminalQuickCommands /
 * terminalRespond) consumed by DeviceDetail + TerminalPane.
 *
 * No DOM needed — these are string/record builders.
 */

import { describe, expect, it } from 'vitest';
import {
  TIMELINES,
  blastRadiusFor,
  configPreviewFor,
  deviceProfile,
  portPreview,
  previewMetaFor,
  ssidPreview,
  terminalBanner,
  terminalQuickCommands,
  terminalRespond,
  timelineFor,
  vlanPreview,
} from '../../../shared';
import type { ClientRow, PortForm, SsidForm, VlanForm } from '../../../shared';

// timelineFor only reads client.health — a minimal row is an honest input.
const clientWith = (health: string): ClientRow => ({ health }) as ClientRow;

describe('Configure previews — ssidPreview / portPreview / vlanPreview', () => {
  it('renders the enterprise SSID push verbatim', () => {
    const form: SsidForm = {
      name: 'MRDN-Staff',
      vlan: '812',
      security: 'wpa3-enterprise',
      group: 'staff-wireless',
      bands: '5+6',
      broadcast: true,
      isolate: false,
      noDfs: false,
      plane: 'CENTRAL',
    };
    expect(ssidPreview(form)).toBe(
      'wlan ssid-profile "MRDN-Staff"\n' +
        '    essid MRDN-Staff\n' +
        '    opmode wpa3-aes-ccm-128\n' +
        '    vlan 812\n' +
        '    dot1x-server-group clearpass\n' +
        '    band 5ghz 6ghz\n' +
        '!\n' +
        'ap-group "staff-wireless"\n' +
        '    virtual-ap "MRDN-Staff"\n' +
        '!\n' +
        '# central  → PUT /configuration/v2/wlan/staff-wireless\n' +
        '# mist     → read-only, opens in console with this payload\n' +
        '# clearpass→ no change needed (radsec trust exists)',
    );
  });

  it('renders the PSK branch with hide-ssid / isolate / noDfs toggles', () => {
    const form: SsidForm = {
      name: 'MRDN-Guest',
      vlan: '812',
      security: 'wpa2-psk',
      group: 'all-sites',
      bands: 'all',
      broadcast: false,
      isolate: true,
      noDfs: true,
      plane: 'CENTRAL',
    };
    expect(ssidPreview(form)).toBe(
      'wlan ssid-profile "MRDN-Guest"\n' +
        '    essid MRDN-Guest\n' +
        '    opmode wpa2-psk-aes\n' +
        '    vlan 812\n' +
        '    wpa-passphrase vault://meridian/wlan/mrdn-guest\n' +
        '    band 2.4ghz 5ghz 6ghz\n' +
        '    hide-ssid\n' +
        '    deny-inter-user-traffic\n' +
        '!\n' +
        'ap-group "all-sites"\n' +
        '    virtual-ap "MRDN-Guest"\n' +
        '    rf-band-profile exclude-dfs\n' +
        '!\n' +
        '# central  → PUT /configuration/v2/wlan/all-sites\n' +
        '# mist     → read-only, opens in console with this payload\n' +
        '# clearpass→ no change needed (radsec trust exists)',
    );
  });

  it('renders an access port push verbatim', () => {
    const form: PortForm = {
      device: 'sw-acc-3f-2',
      id: '1/1/14',
      desc: 'ap-3f-12 uplink',
      mode: 'access',
      vlan: '812',
      poe: true,
      dot1x: true,
      mab: false,
      up: true,
    };
    expect(portPreview(form)).toBe(
      'interface 1/1/14\n' +
        '    description ap-3f-12 uplink\n' +
        '    no shutdown\n' +
        '    vlan access 812\n' +
        '    power-over-ethernet allocate-by class\n' +
        '    aaa authentication port-access dot1x authenticator\n' +
        '        enable\n' +
        '!\n' +
        '# device   → sw-acc-3f-2 (local collector, recorded session)\n' +
        '# rollback → snapshot taken before the push, one-click revert for 24h',
    );
  });

  it('renders a trunk port with an empty optional description honestly', () => {
    const form: PortForm = {
      device: 'sw-core-a',
      id: '1/1/22',
      desc: '',
      mode: 'trunk',
      vlan: '10',
      poe: false,
      dot1x: false,
      mab: true,
      up: false,
    };
    expect(portPreview(form)).toBe(
      'interface 1/1/22\n' +
        '    description \n' + // empty desc is emitted as-is (trailing space), no fallback
        '    shutdown\n' +
        '    vlan trunk native 10\n' +
        '    vlan trunk allowed 10,820,816\n' +
        '    no power-over-ethernet\n' +
        '    aaa authentication port-access mac-auth\n' +
        '        enable\n' +
        '!\n' +
        '# device   → sw-core-a (local collector, recorded session)\n' +
        '# rollback → snapshot taken before the push, one-click revert for 24h',
    );
  });

  it('renders a VLAN push with two helpers as baseline-satisfied', () => {
    const form: VlanForm = { id: '812', name: 'guest-wifi', helpers: '10.42.0.20, 10.44.0.20', scope: 'cx-campus-01' };
    expect(vlanPreview(form)).toBe(
      'vlan 812\n' +
        '    name guest-wifi\n' +
        '    ip helper-address 10.42.0.20\n' +
        '    ip helper-address 10.44.0.20\n' +
        '!\n' +
        '# scope    → cx-campus-01 (42 switches)\n' +
        '# baseline → CX switch baseline expects two helpers — satisfied',
    );
  });

  it('renders an empty helper field as one empty helper line, drift remains', () => {
    const form: VlanForm = { id: '820', name: 'clinical', helpers: '', scope: 'core-only' };
    expect(vlanPreview(form)).toBe(
      'vlan 820\n' +
        '    name clinical\n' +
        '    ip helper-address \n' + // ''.split(',') yields one empty entry
        '!\n' +
        '# scope    → core-only (2 core switches)\n' +
        '# baseline → CX switch baseline expects two helpers — still one, drift remains',
    );
  });

  it('configPreviewFor dispatches port → portPreview, vlan → vlanPreview, else ssidPreview', () => {
    const ssid: SsidForm = {
      name: 'MRDN-Staff',
      vlan: '812',
      security: 'open',
      group: 'staff-wireless',
      bands: '5',
      broadcast: true,
      isolate: false,
      noDfs: false,
      plane: 'MIST',
    };
    const port: PortForm = { device: 'sw-core-a', id: '1/1/1', desc: 'x', mode: 'access', vlan: '8', poe: false, dot1x: false, mab: false, up: true };
    const vlan: VlanForm = { id: '8', name: 'mgmt', helpers: '10.42.0.20', scope: 'cx-all' };
    expect(configPreviewFor('port', port)).toBe(portPreview(port));
    expect(configPreviewFor('vlan', vlan)).toBe(vlanPreview(vlan));
    expect(configPreviewFor('ssid', ssid)).toBe(ssidPreview(ssid));
  });

  it('previewMetaFor labels each plane', () => {
    const ssid: SsidForm = {
      name: 'MRDN-Staff',
      vlan: '812',
      security: 'open',
      group: 'staff-wireless',
      bands: '5',
      broadcast: true,
      isolate: false,
      noDfs: false,
      plane: 'MIST',
    };
    const port: PortForm = { device: 'sw-acc-3f-2', id: '1/1/1', desc: 'x', mode: 'access', vlan: '8', poe: false, dot1x: false, mab: false, up: true };
    const vlan: VlanForm = { id: '8', name: 'mgmt', helpers: '10.42.0.20', scope: 'cx-all' };
    expect(previewMetaFor('ssid', ssid)).toBe('MIST · RENDERED PER PLANE');
    expect(previewMetaFor('port', port)).toBe('SW-ACC-3F-2 · CX CLI');
    expect(previewMetaFor('vlan', vlan)).toBe('CX-ALL · CX CLI');
  });

  it('blastRadiusFor branches on ssid group and vlan helper count', () => {
    const ssid = (group: string): SsidForm => ({
      name: 'n', vlan: '1', security: 'open', group, bands: '5', broadcast: true, isolate: false, noDfs: false, plane: '',
    });
    expect(blastRadiusFor('ssid', ssid('clinical-floors'))[0]).toEqual({
      what: 'Access points that reload the profile',
      count: '268',
    });
    expect(blastRadiusFor('ssid', ssid('staff-wireless'))[0].count).toBe('96');
    expect(blastRadiusFor('ssid', ssid('anything-else'))[0].count).toBe('44');

    const vlan = (helpers: string): VlanForm => ({ id: '812', name: 'guest-wifi', helpers, scope: 'cx-campus-01' });
    expect(blastRadiusFor('vlan', vlan('10.42.0.20, 10.44.0.20'))[2]).toEqual({
      what: 'Compliance findings resolved',
      count: '1',
    });
    expect(blastRadiusFor('vlan', vlan('10.42.0.20'))[2].count).toBe('0');
  });
});

describe('timelineFor — session timeline selection', () => {
  it("'auth failing' selects the reject timeline", () => {
    expect(timelineFor(clientWith('auth failing'))).toBe(TIMELINES.reject);
  });

  it("'no address' selects the dhcp timeline", () => {
    expect(timelineFor(clientWith('no address'))).toBe(TIMELINES.dhcp);
  });

  it('any other health string selects the default timeline', () => {
    expect(timelineFor(clientWith('healthy'))).toBe(TIMELINES.default);
    expect(timelineFor(clientWith('flapping'))).toBe(TIMELINES.default);
  });
});

describe('deviceProfile — name-prefix routing', () => {
  it('mm-/mc- devices get the AOS-8 mobility-master profile (kind aos)', () => {
    const p = deviceProfile('mm-lake-1');
    expect(p.kind).toBe('aos');
    expect(p.prompt).toBe('(mm-lake-1) [mynode] #');
    expect(p.model).toBe('AOS-8 MM-VA');
    expect(deviceProfile('mc-lake-2').kind).toBe('aos');
  });

  it('ap-/uxi- devices are cloud-claimed (kind none, read-only note)', () => {
    const p = deviceProfile('ap-3f-12');
    expect(p.kind).toBe('none');
    expect(p.prompt).toBe('');
    expect(p.readOnlyNote).toBe(
      'This device is cloud-claimed, so the portal exposes read-only telemetry and a remote-shell request instead of a direct SSH session. Approve the request in Mist and the session opens here.',
    );
    expect(deviceProfile('uxi-cam01-2').model).toBe('UXI G2 sensor');
  });

  it('gw- devices get the AOS-10 gateway profile (kind aos)', () => {
    const p = deviceProfile('gw-edge-1');
    expect(p.kind).toBe('aos');
    expect(p.prompt).toBe('(gw-edge-1) #');
  });

  it('cppm* devices get the ClearPass profile (kind sw)', () => {
    const p = deviceProfile('cppm-01');
    expect(p.kind).toBe('sw');
    expect(p.prompt).toBe('[appadmin@cppm-01]#');
  });

  it('unknown names fall back to the CX switch profile', () => {
    const p = deviceProfile('sw-core-a');
    expect(p.kind).toBe('sw');
    expect(p.prompt).toBe('sw-core-a#');
    expect(p.model).toBe('CX 8325-48Y8C');
    expect(p.listTitle).toBe('Ports of interest');
  });

  it('an empty name falls back to the sw-core-a default', () => {
    const p = deviceProfile('');
    expect(p.name).toBe('sw-core-a');
    expect(p.prompt).toBe('sw-core-a#');
  });
});

describe('terminalBanner / terminalQuickCommands — per device kind', () => {
  it('aos devices get the jump-host banner', () => {
    expect(terminalBanner('aos')).toEqual([
      { text: 'Connecting via portal jump host 10.48.0.9 …', tone: 'muted' },
      { text: 'Last login: Fri Jul 25 09:12:04 2026 from 10.42.0.9', tone: 'muted' },
      { text: 'ArubaOS 8.10.0.10 — session logged to ticket NET-4173', tone: 'muted' },
      { text: '', tone: 'muted' },
    ]);
  });

  it('sw devices get the collector banner', () => {
    expect(terminalBanner('sw')).toEqual([
      { text: 'SSH session opened by r.okafor via collector-01 (10.42.0.9)', tone: 'muted' },
      { text: 'ArubaOS-CX FL.10.13.1005 — all commands are recorded', tone: 'muted' },
      { text: 'Type ? for the command list this portal can proxy.', tone: 'muted' },
      { text: '', tone: 'muted' },
    ]);
  });

  it("kind 'none' has no shell — it falls through to the sw banner", () => {
    expect(terminalBanner('none')).toEqual(terminalBanner('sw'));
  });

  it('quick commands differ per kind, none falls through to the sw list', () => {
    expect(terminalQuickCommands('aos')).toEqual(['show version', 'show switches', 'show ap database', 'show datapath tunnel']);
    expect(terminalQuickCommands('sw')).toEqual(['show version', 'show system', 'show interface brief', 'show vlan', 'show lldp neighbor']);
    expect(terminalQuickCommands('none')).toEqual(terminalQuickCommands('sw'));
  });
});

describe('terminalRespond — canned-shell responder', () => {
  const sw = { kind: 'sw' } as const;
  const aos = { kind: 'aos' } as const;

  it('blank input appends nothing', () => {
    expect(terminalRespond(sw, '   ')).toEqual([]);
  });

  it("'?' / 'help' lists the proxied commands, indented, body tone", () => {
    const lines = terminalRespond(sw, '?');
    expect(lines).toHaveLength(6); // SW_TERMINAL_RESPONSES has 6 commands
    expect(lines![0]).toEqual({ text: '  show version', tone: 'body' });
    expect(terminalRespond(aos, 'help')).toHaveLength(4); // AOS_TERMINAL_RESPONSES has 4
  });

  it("'clear' returns null — the caller resets to the banner", () => {
    expect(terminalRespond(sw, 'clear')).toBeNull();
    expect(terminalRespond(aos, 'clear')).toBeNull();
  });

  it('an exact command returns its canned output as body lines', () => {
    const lines = terminalRespond(aos, 'show version');
    expect(lines![0]).toEqual({ text: 'Aruba Operating System Software', tone: 'body' });
    expect(lines).toHaveLength(5);
  });

  it('an unambiguous prefix gets the "did you mean" hint', () => {
    expect(terminalRespond(sw, 'show v')).toEqual([{ text: 'Ambiguous — did you mean: show version', tone: 'warn' }]);
  });

  it('unknown input gets a platform-accurate parse error', () => {
    expect(terminalRespond(sw, 'frobnicate')).toEqual([
      { text: 'Invalid input: frobnicate', tone: 'warn' },
      { text: 'Type ? for the proxied command list.', tone: 'muted' },
    ]);
    expect(terminalRespond(aos, 'frobnicate')).toEqual([
      { text: '% Parse error at frobnicate', tone: 'warn' },
      { text: 'Type ? for the proxied command list.', tone: 'muted' },
    ]);
  });
});
