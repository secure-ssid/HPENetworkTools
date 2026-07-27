/**
 * server/tests/topology.test.ts — buildSiteTopology() unit tests, NO network.
 *
 * The layered wiring diagram is computed from the recorded chain (SITE_CHAIN),
 * the AP uplink map (AP_UPLINK) and the site profile's device rows — the tests
 * pin the honest-wiring rules: edges only where data carries them, APs
 * collapsing per parent switch, VSX pairing named only when both roles say
 * vsx, single-parent inference only when exactly one candidate exists, and
 * layers with no nodes omitted.
 */

import { describe, expect, it } from 'vitest';
import { AP_UPLINK, SITE_CHAIN, SITE_PROFILES, buildSiteTopology } from '../../shared';

const campus01 = SITE_PROFILES['campus-01']!;
const lakeshore = SITE_PROFILES.lakeshore!;
const riverside = SITE_PROFILES.riverside!;

function edge(topo: ReturnType<typeof buildSiteTopology>, from: string, to: string) {
  return topo.edges.find((e) => e.from === from && e.to === to);
}
function node(topo: ReturnType<typeof buildSiteTopology>, id: string) {
  return topo.nodes.find((n) => n.id === id);
}

describe('buildSiteTopology — campus-01 (full chain)', () => {
  const topo = buildSiteTopology('campus-01', campus01.devices, SITE_CHAIN['campus-01'] ?? null, AP_UPLINK);

  it('lays out all five layers in order', () => {
    expect(topo.layers).toEqual(['wan', 'gateway', 'core', 'access', 'edge']);
  });

  it('anchors the chain: exit → gateway (wan label) → core', () => {
    expect(node(topo, 'exit')).toMatchObject({ label: 'DC1 border', layer: 'wan', device: null });
    expect(edge(topo, 'exit', 'dev:gw-edge-1')?.label).toBe(SITE_CHAIN['campus-01']!.wan);
    expect(edge(topo, 'dev:gw-edge-1', 'dev:sw-core-a')?.label).toBeNull();
    expect(node(topo, 'dev:sw-core-a')).toMatchObject({ layer: 'core', device: 'sw-core-a' });
  });

  it('places the second gateway and the VSX peer from their roles', () => {
    expect(node(topo, 'dev:gw-edge-2')).toMatchObject({ layer: 'gateway' });
    expect(edge(topo, 'dev:gw-edge-2', 'dev:sw-core-a')).toBeTruthy();
    expect(node(topo, 'dev:sw-core-b')).toMatchObject({ layer: 'core' });
    // both roles say 'vsx' — the pair link is named, not invented for others
    expect(edge(topo, 'dev:sw-core-b', 'dev:sw-core-a')?.label).toBe('vsx pair');
  });

  it('wires APs only where an uplink is recorded at this site', () => {
    // ap-3f-08's recorded parent sw-acc-3f-3 is at the site → edge
    expect(edge(topo, 'dev:sw-acc-3f-3', 'dev:ap-3f-08')).toBeTruthy();
    // ap-1f-04's recorded parent (sw-acc-1f-1) is NOT in the site rows → honest, no edge
    expect(node(topo, 'dev:ap-1f-04')).toBeTruthy();
    expect(topo.edges.some((e) => e.to === 'dev:ap-1f-04')).toBe(false);
  });

  it('keeps sensors and policy nodes as unconnected leaves', () => {
    expect(node(topo, 'dev:uxi-cam01-2')).toMatchObject({ layer: 'edge' });
    expect(topo.edges.some((e) => e.to === 'dev:uxi-cam01-2')).toBe(false);
    expect(topo.edges.some((e) => e.to === 'dev:cppm-01')).toBe(false);
  });

  it('sorts nodes alphabetically within a layer and references only real node ids', () => {
    const access = topo.nodes.filter((n) => n.layer === 'access').map((n) => n.label);
    expect(access).toEqual([...access].sort((a, b) => a.localeCompare(b)));
    const ids = new Set(topo.nodes.map((n) => n.id));
    expect(topo.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it('says where the wiring comes from', () => {
    expect(topo.note).toContain('recorded uplink');
  });
});

describe('buildSiteTopology — lakeshore (chain without gateway, AP group)', () => {
  const topo = buildSiteTopology('lakeshore', lakeshore.devices, SITE_CHAIN.lakeshore ?? null, AP_UPLINK);

  it('omits the gateway layer entirely', () => {
    expect(topo.layers).toEqual(['wan', 'core', 'edge']);
    expect(edge(topo, 'exit', 'dev:sw-lake-1')?.label).toBe(SITE_CHAIN.lakeshore!.wan);
  });

  it('collapses the two APs on sw-lake-1 into one group chip', () => {
    const grp = node(topo, 'grp:sw-lake-1:ap');
    expect(grp).toMatchObject({ label: '2 APs', sub: 'on sw-lake-1', layer: 'edge', device: null });
    expect(grp?.members?.map((m) => m.name)).toEqual(['ap-t1-12', 'ap-t2-04']);
    expect(edge(topo, 'dev:sw-lake-1', 'grp:sw-lake-1:ap')).toBeTruthy();
    expect(node(topo, 'dev:ap-t1-12')).toBeUndefined(); // members render from the chip
  });

  it('hangs the controllers under the core', () => {
    expect(node(topo, 'dev:mm-lake-1')).toMatchObject({ layer: 'edge' });
    expect(edge(topo, 'dev:mm-lake-1', 'dev:sw-lake-1')).toBeTruthy();
    expect(edge(topo, 'dev:mc-lake-2', 'dev:sw-lake-1')).toBeTruthy();
    // the group's tone rolls up the worst member (mc-lake-2 is danger, but APs are up)
    expect(node(topo, 'grp:sw-lake-1:ap')?.tone).toBe('success');
  });
});

describe('buildSiteTopology — riverside (no chain record)', () => {
  const topo = buildSiteTopology('riverside', riverside.devices, null, AP_UPLINK);

  it('drops the wan/gateway layers and says why', () => {
    expect(topo.layers).toEqual(['core', 'access', 'edge']);
    expect(topo.note).toContain('no forwarding-chain record');
  });

  it('anchors on the core-role device and infers the single AP parent', () => {
    expect(node(topo, 'dev:sw-riv-1')).toMatchObject({ layer: 'core' });
    expect(edge(topo, 'dev:sw-riv-2', 'dev:sw-riv-1')).toBeTruthy();
    // exactly one access switch → both APs infer it, grouped
    const grp = node(topo, 'grp:sw-riv-2:ap');
    expect(grp?.members).toHaveLength(2);
    expect(edge(topo, 'dev:sw-riv-2', 'grp:sw-riv-2:ap')).toBeTruthy();
  });

  it('keeps the member tone honest (unverified APs stay neutral)', () => {
    // the riverside profile rows are 'unverified'/neutral — the chip shows that, not more
    expect(node(topo, 'grp:sw-riv-2:ap')?.tone).toBe('neutral');
  });

  it('rolls the worst member tone up to the group chip', () => {
    const rows = [
      { name: 'ap-x-1', model: 'AP-515', plane: 'LOCAL', planeTone: 'neutral', role: 'ward', state: 'up', stateTone: 'success', uptime: '9d' },
      { name: 'ap-x-2', model: 'AP-515', plane: 'LOCAL', planeTone: 'neutral', role: 'ward', state: 'down', stateTone: 'danger', uptime: '—' },
      { name: 'sw-x-1', model: 'CX 6200', plane: 'LOCAL', planeTone: 'neutral', role: 'access', state: 'up', stateTone: 'success', uptime: '9d' },
    ] as const;
    const t = buildSiteTopology('riverside', [...rows], null, {});
    const grp = t.nodes.find((n) => n.id === 'grp:sw-x-1:ap');
    expect(grp?.tone).toBe('danger');
    expect(grp?.state).toBe('degraded');
  });
});

describe('buildSiteTopology — degenerate inputs', () => {
  it('returns an empty diagram for a site with no devices and no chain', () => {
    const topo = buildSiteTopology('warehouse-dc2', [], null);
    expect(topo.nodes).toEqual([]);
    expect(topo.edges).toEqual([]);
    expect(topo.layers).toEqual([]);
  });

  it('renders chain anchors even with no device rows', () => {
    const topo = buildSiteTopology('campus-01', [], SITE_CHAIN['campus-01'] ?? null);
    expect(topo.layers).toEqual(['wan', 'gateway', 'core']);
    expect(topo.nodes.map((n) => n.device)).toEqual([null, null, null]); // no click-through without rows
  });
});
