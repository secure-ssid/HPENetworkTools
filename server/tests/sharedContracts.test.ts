/**
 * server/tests/sharedContracts.test.ts — the shared contracts the plane
 * adapters, the poller and the screen endpoints all read.
 *
 * Covers the additions made for live parity:
 *   - staleAfterSecFor / planeStaleness: ONE age-based definition of "this
 *     plane's rows cannot be presented as current" (design rule 1), instead of
 *     each consumer keying on health === 'degraded'.
 *   - laneSyncStamp / UNKNOWN_LANE_META: a lane header for an unmapped plane
 *     states that it has no freshness stamp; it never claims to be linked.
 *   - deviceTerminalKind: shell class from the live inventory row, not from
 *     the demo name-prefix convention.
 *   - ssidPreview options: the demo estate's vault path / server group / plane
 *     comments are defaults, not hardcoded truths — and the defaults are still
 *     byte-identical.
 *   - PlanePull's new channels (config, assignments, partial) and PlaneState's
 *     new optional facts.
 *   - OVERVIEW_ALERTS: the demo "Needs you now" rows carry siteName/siteId
 *     exactly as the live mapper sends them, and only for a real site.
 *   - The ON-DEMAND detail-read contract: detailState/detailHasRows keep
 *     "never asked", "genuinely empty" and "call failed" as three different
 *     answers, and PlaneAdapter's optional clientDetail/deviceDetail/
 *     siteTopology return null for "this plane cannot answer".
 *   - Field provenance: planeSupportsClientField / clientFieldProvenance, so a
 *     blank zone on Central says Central has no zone concept instead of
 *     blaming Central for not reporting a field it never modelled.
 */

import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_ALERTS,
  PLANE_DATASET_KEYS,
  PLANE_ROW_DATASET_KEYS,
  UNKNOWN_LANE_META,
  clientFieldProvenance,
  detailHasRows,
  detailState,
  deviceTerminalKind,
  isRealSiteId,
  laneSyncStamp,
  planeKeyOf,
  planeStaleness,
  planeSupportsClientField,
  ssidPreview,
  staleAfterSecFor,
  type ClientDetailLive,
  type ClientDetailSection,
  type ClientTimelineEvent,
  type ConfigInventory,
  type DetailSource,
  type DeviceRadio,
  type SiteTopologyLive,
  type SsidForm,
  type SubscriptionAssignment,
  type TopologyLink,
} from '../../shared';
import type { PlaneAdapter, PlanePull, PlaneState } from '../src/planes/types';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe('staleAfterSecFor — one staleness window for registry, poller and screens', () => {
  it('is three poll intervals, with a 90s floor', () => {
    expect(staleAfterSecFor(60)).toBe(180);
    expect(staleAfterSecFor(300)).toBe(900);
    expect(staleAfterSecFor(10)).toBe(90); // floor: one slow pull is not staleness
    expect(staleAfterSecFor(0)).toBe(90);
  });
});

describe('planeStaleness — age-based, with the reason', () => {
  const linked = { linked: true, health: 'healthy' as const };

  it('a fresh healthy plane is current', () => {
    const s = planeStaleness({ ...linked, lastSync: ago(30_000) }, 180, NOW);
    expect(s).toEqual({ lastSync: ago(30_000), ageSec: 30, stale: false, reason: null });
  });

  it('a plane whose poller quietly stopped is stale even while it reads healthy', () => {
    const s = planeStaleness({ ...linked, lastSync: ago(6 * 3_600_000) }, 180, NOW);
    expect(s.stale).toBe(true);
    expect(s.reason).toBe('aged-out');
    expect(s.ageSec).toBe(21_600);
  });

  it('linked but never synced is stale — there is nothing to present', () => {
    const s = planeStaleness({ ...linked, lastSync: null }, 180, NOW);
    expect(s).toEqual({ lastSync: null, ageSec: null, stale: true, reason: 'never-synced' });
  });

  it('a failed poll is stale by reason even with a recent stamp', () => {
    const s = planeStaleness({ linked: true, health: 'degraded', lastSync: ago(5_000) }, 180, NOW);
    expect(s.stale).toBe(true);
    expect(s.reason).toBe('degraded');
  });

  it('a partial pull (health warning) is stale — half a plane is not a verified plane', () => {
    const s = planeStaleness({ linked: true, health: 'warning', lastSync: ago(5_000) }, 180, NOW);
    expect(s.stale).toBe(true);
    expect(s.reason).toBe('partial');
  });

  it('an unlinked plane is not stale — it contributes no rows to be stale', () => {
    const s = planeStaleness({ linked: false, health: 'unlinked', lastSync: null }, 180, NOW);
    expect(s.stale).toBe(false);
    expect(s.reason).toBeNull();
  });
});

describe('lane headers never claim linkage they cannot back', () => {
  it('UNKNOWN_LANE_META is non-asserting', () => {
    expect(UNKNOWN_LANE_META.state).toBe('unknown');
    expect(UNKNOWN_LANE_META.sync).toBe('no sync stamp');
    expect(UNKNOWN_LANE_META.note).not.toMatch(/linked/i);
  });

  it('laneSyncStamp: a stamp ages, null says never, undefined says nothing at all', () => {
    expect(laneSyncStamp(ago(40_000), NOW)).toBe('synced 40s');
    expect(laneSyncStamp(null, NOW)).toBe('never synced');
    expect(laneSyncStamp(undefined, NOW)).toBe(UNKNOWN_LANE_META.sync);
  });
});

describe('deviceTerminalKind — the live row beats the demo name prefix', () => {
  it("a Mist AP named 'AP-Floor3' is cloud-claimed, not a CX switch", () => {
    expect(deviceTerminalKind({ type: 'ap' }, 'AP-Floor3')).toBe('none');
    expect(deviceTerminalKind({ type: 'sensor' }, 'Office-Sensor-2')).toBe('none');
  });

  it("a real CX switch named 'ap-closet-sw' still gets a shell", () => {
    expect(deviceTerminalKind({ type: 'switch' }, 'ap-closet-sw')).toBe('sw');
  });

  it('gateways and controllers speak AOS; policy appliances speak the sw dialect', () => {
    expect(deviceTerminalKind({ type: 'gateway' }, 'Edge-1')).toBe('aos');
    expect(deviceTerminalKind({ type: 'controller' }, 'Lake-MC')).toBe('aos');
    expect(deviceTerminalKind({ type: 'policy' }, 'cppm-01')).toBe('sw');
  });

  it('falls back to the demo prefix rules only when there is no live row', () => {
    expect(deviceTerminalKind(null, 'ap-3f-12')).toBe('none');
    expect(deviceTerminalKind(null, 'mm-hq-1')).toBe('aos');
    expect(deviceTerminalKind(null, 'sw-core-a')).toBe('sw');
  });
});

describe('ssidPreview — the demo estate is a default, not a hardcoded truth', () => {
  const form: SsidForm = {
    name: 'MRDN-Guest',
    vlan: '812',
    security: 'psk-portal',
    group: 'guest-lobby',
    bands: 'all',
    broadcast: true,
    isolate: false,
    noDfs: false,
    plane: 'CENTRAL',
  };

  it('renders the authored demo output byte-for-byte with no options', () => {
    expect(ssidPreview(form)).toBe(
      'wlan ssid-profile "MRDN-Guest"\n    essid MRDN-Guest\n    opmode wpa2-psk-aes\n    vlan 812' +
        '\n    wpa-passphrase vault://meridian/wlan/mrdn-guest\n    band 2.4ghz 5ghz 6ghz' +
        '\n!\nap-group "guest-lobby"\n    virtual-ap "MRDN-Guest"' +
        '\n!\n# central  → PUT /configuration/v2/wlan/guest-lobby' +
        '\n# mist     → read-only, opens in console with this payload' +
        '\n# clearpass→ no change needed (radsec trust exists)',
    );
  });

  it('takes the deployment secret reference instead of the fixture vault path', () => {
    const out = ssidPreview(form, { passphraseRef: 'set in the plane console' });
    expect(out).toContain('\n    wpa-passphrase set in the plane console');
    expect(out).not.toContain('vault://meridian');
  });

  it('takes the real RADIUS server group for enterprise modes', () => {
    const ent: SsidForm = { ...form, security: 'wpa3-enterprise' };
    expect(ssidPreview(ent)).toContain('\n    dot1x-server-group clearpass');
    expect(ssidPreview(ent, { dot1xGroup: 'radius-primary' })).toContain('\n    dot1x-server-group radius-primary');
  });

  it('renders live per-plane API-call annotations, and omits the block entirely for []', () => {
    const live = ssidPreview(form, {
      planeNotes: ['central  → PUT /configuration/v2/wlan/guest-lobby', 'mist     → not linked'],
    });
    expect(live).toContain('\n# central  → PUT /configuration/v2/wlan/guest-lobby\n# mist     → not linked');
    expect(live).not.toContain('clearpass');

    const bare = ssidPreview(form, { planeNotes: [] });
    expect(bare.endsWith('virtual-ap "MRDN-Guest"\n!')).toBe(true);
    expect(bare).not.toContain('#');
  });
});

describe('PlanePull / PlaneState — the new channels are additive and optional', () => {
  it('row datasets are a strict subset of the dataset keys', () => {
    for (const key of PLANE_ROW_DATASET_KEYS) {
      expect(PLANE_DATASET_KEYS).toContain(key);
    }
    expect(PLANE_ROW_DATASET_KEYS).not.toContain('config' as never);
    expect(PLANE_ROW_DATASET_KEYS).not.toContain('assignments' as never);
    expect(PLANE_DATASET_KEYS).toContain('config');
    expect(PLANE_DATASET_KEYS).toContain('assignments');
  });

  it('a pull can report a config inventory, assignments and unread datasets', () => {
    const config: ConfigInventory = {
      mode: 'configured',
      source: 'central /configuration/v2/wlan · 2 groups',
      ssids: [{ kind: 'ssid', origin: 'configured', name: 'CORP', vlan: 'vlan 10', security: 'WPA3-Enterprise', targets: 'all', plane: 'CENTRAL', tone: 'accent' }],
      unavailable: ['ports'],
    };
    const assignments: SubscriptionAssignment[] = [
      { serial: 'CNF7G0X123', assigned: true, subscriptionKey: 'FOUNDATION-AP', expires: '2027-01-31' },
      { serial: 'CNF7G0X999', assigned: false, subscriptionKey: null },
    ];
    const pull: PlanePull = { devices: [], config, assignments, partial: ['sites'] };

    expect(pull.config?.mode).toBe('configured');
    expect(pull.config?.vlans).toBeUndefined(); // absent ≠ "this plane has no VLANs"
    expect(pull.assignments?.filter((a) => a.assigned === false)).toHaveLength(1);
    expect(pull.partial).toEqual(['sites']);
  });

  it('a bare pull and a bare state still satisfy the contract', () => {
    const pull: PlanePull = {};
    const state: PlaneState = {
      id: 'central',
      linked: true,
      health: 'healthy',
      lastSync: null,
      deviceCount: null,
      callsToday: 0,
      note: null,
    };
    expect(pull.config).toBeUndefined();
    expect(state.capabilities).toBeUndefined();
    expect(state.token).toBeUndefined();
    expect(state.callBudget).toBeUndefined();
    expect(state.scope).toBeUndefined();
  });

  it('capabilities and the token fact carry no secret material', () => {
    const state: PlaneState = {
      id: 'local',
      linked: true,
      health: 'healthy',
      lastSync: '2026-07-26T11:59:00.000Z',
      deviceCount: 12,
      callsToday: 40,
      note: null,
      callBudget: 20_000,
      capabilities: { localShell: true, brokeredWrite: true, configRead: false },
      token: { expiresAt: '2026-08-12T00:00:00.000Z', source: 'oauth client_credentials' },
      scope: 'read + ssh',
      scopeNote: 'recorded SSH through the local collector',
      consecutiveFailures: 0,
      nextAttemptAt: null,
    };
    expect(state.capabilities?.localShell).toBe(true);
    expect(Object.keys(state.token ?? {})).toEqual(['expiresAt', 'source']);
  });
});

describe('OVERVIEW_ALERTS — the demo "Needs you now" rows say where, the same way live rows do', () => {
  it('every row that names a site carries it as fields, and the id is a real site', () => {
    const withSite = OVERVIEW_ALERTS.filter((a) => a.siteName !== undefined);
    expect(withSite.map((a) => a.siteName)).toEqual([
      'Lakeshore Medical Center',
      'Campus-02 Research',
      'Campus-01',
    ]);
    for (const a of withSite) {
      // A bookkeeping id ('workspace', 'multiple') would render a jump to a
      // site page that has to 404 — only a real inventory row may be linked.
      expect(isRealSiteId(a.siteId ?? '')).toBe(true);
    }
  });

  it('the prose prefix is kept, so a meta-only renderer still says where', () => {
    for (const a of OVERVIEW_ALERTS) {
      if (a.siteName === undefined) continue;
      expect(a.meta.startsWith(`${a.siteName} · `)).toBe(true);
      // …and what is left once a site-aware renderer strips it is never empty,
      // so the row does not lose its detail line to the de-duplication.
      expect(a.meta.slice(a.siteName.length + 3).trim()).not.toBe('');
    }
  });

  it('a row with no site field has no id either — never a blank or dead jump', () => {
    for (const a of OVERVIEW_ALERTS) {
      if (a.siteName !== undefined) continue;
      expect(a.siteId).toBeUndefined();
    }
    // The two field-less rows are the plane-endpoint and workspace rows: they
    // keep the demo exercising the same "cannot be mapped" branch live takes.
    expect(OVERVIEW_ALERTS.filter((a) => a.siteName === undefined).map((a) => a.plane)).toEqual([
      'CLASSIC',
      'GREENLAKE',
    ]);
  });
});

// ---------------------------------------------------------------------------
// On-demand detail reads — the three-state contract and field provenance
// ---------------------------------------------------------------------------

describe('detailState — "never asked", "genuinely empty" and "call failed" are three answers', () => {
  const source: DetailSource<ClientDetailSection> = {
    plane: 'central',
    at: '2026-07-26T12:00:00.000Z',
    sections: { roams: 'empty', timeline: 'empty', tput: 'ok', usageSeries: 'failed' },
  };

  it('a section the adapter never set reads as not-fetched, not as empty', () => {
    // rssi was never attempted. If this collapsed to 'empty' the drawer would
    // claim the plane reported no signal, which it never said.
    expect(detailState(source, 'rssi')).toBe('not-fetched');
  });

  it('an authoritative zero is "empty", which is an answer and not an error', () => {
    expect(detailState(source, 'roams')).toBe('empty');
  });

  it('a broken call stays "failed" so the screen never implies the plane has nothing', () => {
    expect(detailState(source, 'usageSeries')).toBe('failed');
  });

  it('no source at all is not-fetched — a null payload never reads as empty', () => {
    expect(detailState(null, 'timeline')).toBe('not-fetched');
    expect(detailState(undefined, 'timeline')).toBe('not-fetched');
  });
});

describe('detailHasRows — an absent array and an empty array are not the same thing', () => {
  const at = '2026-07-26T12:00:00.000Z';
  const detail = (
    sections: DetailSource<ClientDetailSection>['sections'],
    timeline?: ClientTimelineEvent[],
  ): ClientDetailLive => ({ mac: '00:11:22:33:44:55', timeline, source: { plane: 'central', at, sections } });

  it('is false for a stationary client with no roams — and the state says why', () => {
    const d = detail({ timeline: 'empty' }, []);
    expect(detailHasRows(d.source, 'timeline', d.timeline)).toBe(false);
    expect(detailState(d.source, 'timeline')).toBe('empty'); // "no roaming in the last 24h"
  });

  it('is false for a read that was never issued, which is a different sentence', () => {
    const d = detail({});
    expect(d.timeline).toBeUndefined();
    expect(detailHasRows(d.source, 'timeline', d.timeline)).toBe(false);
    expect(detailState(d.source, 'timeline')).toBe('not-fetched');
  });

  it('is false for a failed read even if a stale array is passed alongside it', () => {
    const d = detail({ timeline: 'failed' }, [
      { ts: at, kind: 'roam', detail: 'roamed ap-a -> ap-b' },
    ]);
    expect(detailHasRows(d.source, 'timeline', d.timeline)).toBe(false);
  });

  it('is true only when the plane answered with rows', () => {
    const d = detail({ timeline: 'ok' }, [{ ts: at, kind: 'roam', detail: 'roamed ap-a -> ap-b' }]);
    expect(detailHasRows(d.source, 'timeline', d.timeline)).toBe(true);
  });
});

describe('planeSupportsClientField — Central models SITE, not zone', () => {
  it('does not claim Central reports a zone or a per-client config group', () => {
    // Central's Client schema places a client with siteId/siteName and nothing
    // else. Saying "not reported by CENTRAL" blames the plane for a field it
    // never had.
    expect(planeSupportsClientField('central', 'zone')).toBe(false);
    expect(planeSupportsClientField('CENTRAL', 'group')).toBe(false);
  });

  it('still holds Central to the fields it DOES model', () => {
    for (const field of ['rssi', 'snr', 'tput', 'roams', 'retries', 'vlan', 'ip'] as const) {
      expect(planeSupportsClientField('central', field)).toBe(true);
    }
  });

  it('asserts nothing about planes that have not been checked', () => {
    // Silence is not evidence: an unchecked plane keeps the existing
    // "not reported by X" wording rather than gaining a claim nobody verified.
    expect(planeSupportsClientField('mist', 'zone')).toBe(true);
    expect(planeSupportsClientField('THIRD-PARTY', 'zone')).toBe(true);
    expect(planeSupportsClientField(null, 'zone')).toBe(true);
  });

  it('accepts either spelling of a plane', () => {
    expect(planeKeyOf('AOS-8')).toBe('aos8');
    expect(planeKeyOf('aos8')).toBe('aos8');
    expect(planeKeyOf('THIRD-PARTY')).toBe(null);
    expect(planeKeyOf(undefined)).toBe(null);
  });
});

describe('clientFieldProvenance — one sentence per situation, for every renderer', () => {
  it('a value present is just present', () => {
    expect(clientFieldProvenance('CENTRAL', 'rssi', '−52 dBm')).toEqual({ kind: 'present' });
  });

  it('a blank zone on Central says Central has no zone concept, never "not reported"', () => {
    const p = clientFieldProvenance('CENTRAL', 'zone', '—');
    expect(p.kind).toBe('unsupported');
    expect(p.kind === 'unsupported' && p.note).toBe('Central places clients by site, not zone');
    expect(p.kind === 'unsupported' && p.note).not.toMatch(/not reported/);
  });

  it('a blank field the plane DOES model is honestly "not reported by CENTRAL"', () => {
    const p = clientFieldProvenance('CENTRAL', 'snr', '—');
    expect(p).toEqual({ kind: 'missing', note: 'not reported by CENTRAL' });
  });

  it('treats every flavour of blank the fixtures and adapters use as blank', () => {
    for (const blank of ['—', '', null, undefined]) {
      expect(clientFieldProvenance('CENTRAL', 'snr', blank).kind).toBe('missing');
    }
    // 0 and '0' are ANSWERS: a client with zero roams reported zero roams.
    expect(clientFieldProvenance('CENTRAL', 'roams', '0')).toEqual({ kind: 'present' });
    expect(clientFieldProvenance('CENTRAL', 'roams', 0)).toEqual({ kind: 'present' });
  });
});

describe('PlaneAdapter detail methods — optional, on-demand, null means "cannot answer"', () => {
  it('an adapter with none of them still satisfies PlaneAdapter', () => {
    const bare: PlaneAdapter = {
      id: 'classic',
      state: () => ({
        id: 'classic', linked: false, health: 'unlinked', lastSync: null,
        deviceCount: null, callsToday: 0, note: null,
      }),
      pull: async () => ({}),
    };
    expect(bare.clientDetail).toBeUndefined();
    expect(bare.deviceDetail).toBeUndefined();
    expect(bare.siteTopology).toBeUndefined();
  });

  it('an adapter that cannot answer returns null rather than an invented payload', async () => {
    const adapter: PlaneAdapter = {
      id: 'central',
      state: () => ({
        id: 'central', linked: true, health: 'healthy', lastSync: null,
        deviceCount: 9, callsToday: 86, note: null,
      }),
      pull: async () => ({}),
      clientDetail: async () => null,
      deviceDetail: async (serial, kind) => ({
        serial,
        kind,
        // Asked for, and the switch genuinely has no ports to report — an
        // empty array WITH an 'empty' state, not an absent one.
        ports: [],
        source: { plane: 'central', at: '2026-07-26T12:00:00.000Z', sections: { ports: 'empty' } },
      }),
      siteTopology: async () => null,
    };
    expect(await adapter.clientDetail?.('00:11:22:33:44:55')).toBeNull();
    expect(await adapter.siteTopology?.('79244870000394240')).toBeNull();
    const dev = await adapter.deviceDetail?.('SG30LMR164', 'switch');
    expect(dev?.ports).toEqual([]);
    expect(detailState(dev?.source, 'ports')).toBe('empty');
    // radios were never asked for on a switch — absent, not empty.
    expect(dev?.radios).toBeUndefined();
    expect(detailState(dev?.source, 'radios')).toBe('not-fetched');
  });
});

describe('live-shaped detail rows — the field names and units the tenant actually returns', () => {
  it('a Central radio row types channel as a string and speeds/levels as numbers', () => {
    // Verified live on AP735-LR (PHT5M520SZ): channel '157E' carries a bonding
    // marker, so parsing it to a number would silently drop it.
    const radio: DeviceRadio = {
      number: 0, band: '5 GHz', channel: '157E', bandwidth: '80 MHz',
      powerDbm: 19, clients: 1, channelUtilPct: 9, rxUtilPct: 4, txUtilPct: 1,
      retries: 0, drops: 0, noiseFloorDbm: -93, nonWifiInterference: 4,
      channelQuality: 94, status: 'UP', mode: 'Client Access',
    };
    expect(radio.channel).toBe('157E');
    expect(radio.noiseFloorDbm).toBeLessThan(0);
  });

  it('a topology link is keyed by serial and carries both ends of the cable', () => {
    const link: TopologyLink = {
      from: 'SG30LMR164',
      to: 'PHT5M520SZ',
      fromPorts: [{ name: '1/1/6', index: 6, lag: '', health: 'Good' }],
      toPorts: [{ name: 'eth0', index: 0, lag: null, health: 'Good' }],
      speedBps: 5_000_000_000,
      health: 'Good',
      edgeType: 'System',
    };
    const topo: SiteTopologyLive = {
      siteId: '79244870000394240',
      nodes: [
        {
          serial: 'tpd_204c03ff61e2', name: '20:4c:03:ff:61:e2', type: 'Unmanaged',
          deviceFunction: '-', status: 'ONLINE',
          // The plane assesses no health for an unmanaged node. null is its
          // answer, not a failed read — links to it read 'Unknown', not broken.
          health: null, healthReason: null, model: null, ipv4: null,
          mac: '20:4c:03:ff:61:e2',
        },
      ],
      links: [link],
      source: {
        plane: 'central', at: '2026-07-26T12:00:00.000Z',
        sections: { nodes: 'ok', links: 'ok' },
      },
    };
    expect(topo.links?.[0].from).toBe(link.from);
    expect(topo.nodes?.[0].health).toBeNull();
    expect(detailState(topo.source, 'links')).toBe('ok');
  });
});
