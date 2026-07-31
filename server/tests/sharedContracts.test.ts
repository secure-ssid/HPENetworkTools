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
 *   - The SERVING-RADIO join: Central models rssi and retries per AP RADIO,
 *     never per client, so deriveRssiDbm (RSSI = SNR + noise floor) and
 *     matchServingRadio (band+channel, null when ambiguous) are what fill the
 *     drawer's SIGNAL / RETRIES rows for a client that never roams.
 *   - Field provenance: planeSupportsClientField / clientFieldProvenance, so a
 *     blank zone on Central says Central has no zone concept instead of
 *     blaming Central for not reporting a field it never modelled.
 */

import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_ALERTS,
  PLANE_DATASET_KEYS,
  PLANE_ROW_DATASET_KEYS,
  SSE_LIMITED_RELEASE_KINDS,
  SSE_OBJECT_KINDS,
  SSE_OBJECT_KIND_LABELS,
  UNKNOWN_LANE_META,
  alertAgeMinutes,
  clientFieldProvenance,
  compareAlerts,
  correlateAlerts,
  deriveRssiDbm,
  detailHasRows,
  detailState,
  deviceTerminalKind,
  matchServingRadio,
  isRealSiteId,
  laneSyncStamp,
  planeKeyOf,
  planeStaleness,
  planeSupportsClientField,
  ssidDependencyRequirementsFor,
  ssidPreview,
  hhmmLocal,
  hhmmssLocal,
  staleAfterSecFor,
  type AlertRow,
  type ClientDetailLive,
  type ClientDetailSection,
  type ClientTimelineEvent,
  type ClientWiring,
  type ConfigInventory,
  type DetailSource,
  type DeviceRadio,
  type ServingRadio,
  type SiteTopologyLive,
  type SsidForm,
  type SseInventory,
  type SseManualCleanupRequest,
  type SseManualCleanupResult,
  type SseMutationRequest,
  type SseMutationResult,
  type SseObjectSummary,
  type SubscriptionAssignment,
  type TopologyLink,
} from '@hpe/shared';
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

// ---------------------------------------------------------------------------
// The serving-radio join — SIGNAL and RETRIES for a client that never roams
// ---------------------------------------------------------------------------

describe('deriveRssiDbm — RSSI = SNR + noise floor, and null in means null out', () => {
  it('derives the live Kindle: snr 48 dB on a radio with a -97 dBm noise floor', () => {
    // 00:23:a7:3d:a0:42 on MBB-515 radio 1. Central models no per-client rssi
    // at all, so this arithmetic is the only honest number for the row.
    expect(deriveRssiDbm(48, -97)).toBe(-49);
  });

  it('is null — never 0 — when the noise floor is missing', () => {
    // 0 dBm is a real (and absurd) signal level; emitting it would be a lie.
    expect(deriveRssiDbm(48, null)).toBeNull();
    expect(deriveRssiDbm(48, undefined)).toBeNull();
  });

  it('is null when the client reported no SNR', () => {
    expect(deriveRssiDbm(null, -97)).toBeNull();
    expect(deriveRssiDbm(undefined, -97)).toBeNull();
  });

  it('is null for a non-finite input rather than NaN leaking into a render', () => {
    expect(deriveRssiDbm(Number.NaN, -97)).toBeNull();
    expect(deriveRssiDbm(48, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('matchServingRadio — the radio the client is on, or nothing', () => {
  // Verbatim shape of GET /aps/USHBKD50J4/radios, normalized by the adapter.
  const radio = (over: Partial<DeviceRadio>): DeviceRadio => ({
    number: 0, band: '5 GHz', channel: '40E', bandwidth: '40 MHz', powerDbm: 20,
    clients: 0, channelUtilPct: 5, rxUtilPct: 1, txUtilPct: 1, retries: 2.39,
    drops: 0, noiseFloorDbm: -97, nonWifiInterference: 0, channelQuality: 99,
    status: 'UP', mode: 'Client Access', ...over,
  });
  const RADIO_5 = radio({});
  const RADIO_24 = radio({ number: 1, band: '2.4 GHz', channel: '6', bandwidth: '20 MHz', retries: 0.51, channelQuality: 98, clients: 5 });
  const AP = [RADIO_5, RADIO_24];

  it("matches the client's '6 (20 MHz)' to the radio's bare '6'", () => {
    const hit = matchServingRadio(AP, '2.4 GHz', '6 (20 MHz)');
    expect(hit).toBe(RADIO_24);
    expect(hit?.retries).toBe(0.51); // the RADIO's retries — the drawer must say so
    expect(deriveRssiDbm(48, hit?.noiseFloorDbm ?? null)).toBe(-49);
  });

  it("strips the 5 GHz width marker so '40 (40 MHz)' matches '40E'", () => {
    expect(matchServingRadio(AP, '5 GHz', '40 (40 MHz)')).toBe(RADIO_5);
  });

  it('falls back to band alone when exactly one radio serves that band', () => {
    // Channel drifted between the client read and the radio read; the AP still
    // has only one 2.4 GHz radio, so there is nothing to guess about.
    expect(matchServingRadio(AP, '2.4 GHz', '11')).toBe(RADIO_24);
    expect(matchServingRadio(AP, '2.4 GHz', null)).toBe(RADIO_24);
  });

  it('returns null rather than picking one of two radios on the same band', () => {
    const dual = [RADIO_5, radio({ number: 2, channel: '157E' })];
    expect(matchServingRadio(dual, '5 GHz', '36 (20 MHz)')).toBeNull();
  });

  it('matches on channel alone only when that channel is unique', () => {
    expect(matchServingRadio(AP, null, '6')).toBe(RADIO_24);
    expect(matchServingRadio([RADIO_24, radio({ number: 2, band: '6 GHz', channel: '6' })], null, '6')).toBeNull();
  });

  it('returns null for no radios, no band and no channel — never radios[0]', () => {
    expect(matchServingRadio([], '2.4 GHz', '6')).toBeNull();
    expect(matchServingRadio(undefined, '2.4 GHz', '6')).toBeNull();
    expect(matchServingRadio(AP, null, null)).toBeNull();
    expect(matchServingRadio(AP, '6 GHz', '37')).toBeNull(); // AP has no 6 GHz radio
  });
});

describe('ServingRadio / ClientWiring ride the same three-state machinery', () => {
  it('an unmatched radio and a link-less AP are "empty", not a failed read', () => {
    const detail: ClientDetailLive = {
      mac: '00:23:a7:3d:a0:42',
      source: {
        plane: 'central', at: '2026-07-26T12:00:00.000Z',
        sections: { servingRadio: 'empty', wiring: 'empty' },
      },
    };
    expect(detail.servingRadio).toBeUndefined();
    expect(detail.wiring).toBeUndefined();
    expect(detailState(detail.source, 'servingRadio')).toBe('empty');
    expect(detailState(detail.source, 'wiring')).toBe('empty');
  });

  it('carries the live join: MBB-515 radio 1, and CX6300-CORE port 1/1/8', () => {
    const servingRadio: ServingRadio = {
      serial: 'USHBKD50J4', apName: 'MBB-515', radioNumber: 1, band: '2.4 GHz',
      channel: '6', noiseFloorDbm: -97, retries: 0.51, channelQuality: 98,
      channelUtilPct: null, clients: 5,
    };
    const wiring: ClientWiring = {
      apName: 'MBB-515', apSerial: 'USHBKD50J4', switchName: 'CX6300-CORE',
      switchSerial: 'SG30LMR164', port: '1/1/8', speedBps: 1000000000,
      linkHealth: 'Good',
    };
    const detail: ClientDetailLive = {
      mac: '00:23:a7:3d:a0:42', servingRadio, wiring,
      source: {
        plane: 'central', at: '2026-07-26T12:00:00.000Z',
        sections: { servingRadio: 'ok', wiring: 'ok' },
      },
    };
    expect(detailState(detail.source, 'servingRadio')).toBe('ok');
    expect(detail.servingRadio?.retries).toBe(0.51);
    // An absent metric is null, never 0 — 0% utilization is a real reading.
    expect(detail.servingRadio?.channelUtilPct).toBeNull();
    expect(detail.wiring?.port).toBe('1/1/8');
  });
});

describe('ssidDependencyRequirementsFor — direct SSID apply dependency gates', () => {
  it('requires a role for every security mode', () => {
    for (const security of ['wpa3-enterprise', 'wpa2-enterprise', 'psk-portal', 'wpa2-psk', 'open'] as const) {
      expect(ssidDependencyRequirementsFor(security).role).toBe(true);
    }
  });

  it('requires an authentication server group ONLY for the enterprise modes', () => {
    expect(ssidDependencyRequirementsFor('wpa3-enterprise').authServerGroup).toBe(true);
    expect(ssidDependencyRequirementsFor('wpa2-enterprise').authServerGroup).toBe(true);
    expect(ssidDependencyRequirementsFor('psk-portal').authServerGroup).toBe(false);
    expect(ssidDependencyRequirementsFor('wpa2-psk').authServerGroup).toBe(false);
    expect(ssidDependencyRequirementsFor('open').authServerGroup).toBe(false);
  });

  it('requires a captive-portal profile ONLY for psk-portal', () => {
    expect(ssidDependencyRequirementsFor('psk-portal').captivePortal).toBe(true);
    for (const security of ['wpa3-enterprise', 'wpa2-enterprise', 'wpa2-psk', 'open'] as const) {
      expect(ssidDependencyRequirementsFor(security).captivePortal).toBe(false);
    }
  });

  it('requires a passphrase for wpa2-psk and psk-portal only — open omits credentials entirely', () => {
    expect(ssidDependencyRequirementsFor('wpa2-psk').passphrase).toBe(true);
    expect(ssidDependencyRequirementsFor('psk-portal').passphrase).toBe(true);
    expect(ssidDependencyRequirementsFor('open')).toEqual({
      role: true,
      authServerGroup: false,
      captivePortal: false,
      passphrase: false,
    });
    expect(ssidDependencyRequirementsFor('wpa3-enterprise').passphrase).toBe(false);
    expect(ssidDependencyRequirementsFor('wpa2-enterprise').passphrase).toBe(false);
  });
});

describe('SSE contracts — object kinds, inventory, and the mutation/commit split', () => {
  it('sse joins the dataset keys as a structured object, never a row array', () => {
    expect(PLANE_DATASET_KEYS).toContain('sse');
    expect(PLANE_ROW_DATASET_KEYS).not.toContain('sse' as never);
  });

  it('every object kind has a display label and the limited-release set is a subset of the kinds', () => {
    for (const kind of SSE_OBJECT_KINDS) {
      expect(typeof SSE_OBJECT_KIND_LABELS[kind]).toBe('string');
    }
    for (const kind of SSE_LIMITED_RELEASE_KINDS) {
      expect(SSE_OBJECT_KINDS).toContain(kind);
    }
    // locations/tunnels/applications — the vendor's own documented
    // limited-release surfaces (README "Official facts").
    expect([...SSE_LIMITED_RELEASE_KINDS].sort()).toEqual(['applications', 'locations', 'tunnels']);
  });

  it('an inventory can report some kinds unavailable without losing the ones that read', () => {
    const summary: SseObjectSummary = { kind: 'connectors', id: 'c-1', name: 'edge-1', raw: { id: 'c-1', name: 'edge-1' } };
    const inv: SseInventory = {
      kinds: { connectors: { rows: [summary], total: 1, truncated: false } },
      unavailable: ['users', 'locations'],
      readStatus: {
        connectors: { state: 'ok' },
        users: {
          state: 'failed',
          reason: 'denied',
          httpCode: 403,
          message: 'check token scope',
        },
        locations: {
          state: 'failed',
          reason: 'unsupported',
          httpCode: 404,
          message: 'limited-release',
        },
      },
      source: 'admin-api.axissecurity.com · 7 of 9 object kinds read',
    };
    expect(inv.kinds.connectors?.rows).toHaveLength(1);
    expect(inv.kinds.users).toBeUndefined(); // absent, not an authoritative empty list
    expect(inv.unavailable).toContain('locations');
    expect(inv.readStatus?.users).toMatchObject({ state: 'failed', reason: 'denied' });
  });

  it('a mutation request is typed and NEVER carries a free-form path — only an allowlisted kind', () => {
    const req: SseMutationRequest = { kind: 'connectorZones', action: 'create', fields: { name: 'HQ' }, reviewConfirmed: true };
    expect(SSE_OBJECT_KINDS).toContain(req.kind);
  });

  it('manual cleanup has separate acknowledgments and a machine-readable durable outcome', () => {
    const request: SseManualCleanupRequest = {
      reviewConfirmed: true,
      manualReconciled: true,
    };
    const result: SseManualCleanupResult = {
      commit: {
        attempted: false,
        ok: false,
        httpCode: null,
        acceptance: 'not-attempted',
        message: 'Tenant-wide Commit was not called',
      },
      cacheRefresh: {
        attempted: true,
        status: 'stale',
        message: 'refresh status is explicit',
      },
      recovery: {
        journalPhase: 'commit-transport-unknown',
        action: 'manual-cleanup',
        status: 'journal-removed',
        mutationVerified: false,
        message: 'journal removed; tenant-wide Commit was not called',
      },
    };
    expect(request).toEqual({ reviewConfirmed: true, manualReconciled: true });
    expect(result.recovery).toMatchObject({
      action: 'manual-cleanup',
      status: 'journal-removed',
    });
  });

  it('mutation and commit are reported separately — a staged result is not a success', () => {
    const staged: SseMutationResult = {
      mutation: { ok: true, httpCode: 200, id: 'c-1', message: 'update accepted' },
      commit: { attempted: true, ok: false, httpCode: 500, message: 'commit failed' },
      staged: true,
      cacheRefresh: { attempted: true, status: 'refreshed', message: 'refreshed' },
    };
    expect(staged.mutation.ok).toBe(true);
    expect(staged.staged).toBe(true);

    const notAttempted: SseMutationResult = {
      mutation: { ok: false, httpCode: 409, message: 'conflict' },
      commit: { attempted: false, ok: false, httpCode: null, message: 'not attempted' },
      staged: false,
      cacheRefresh: { attempted: false, status: 'skipped', message: 'nothing to refresh' },
    };
    expect(notAttempted.commit.attempted).toBe(false);
  });

  it('a bare pull can carry only sse and still satisfy PlanePull', () => {
    const pull: PlanePull = {
      sse: { kinds: {}, unavailable: [...SSE_OBJECT_KINDS], source: 'first sync pending' },
      partial: ['sse'],
    };
    expect(pull.devices).toBeUndefined();
    expect(pull.sse?.unavailable).toHaveLength(SSE_OBJECT_KINDS.length);
  });
});

/**
 * The alert banner rule, which the server and the browser both apply. It is
 * one function precisely so the sentence at the top of the queue and the one
 * the API serves can never name a different worst finding.
 */
describe('correlateAlerts', () => {
  const alert = (over: Partial<AlertRow> & { title: string }): AlertRow =>
    ({
      id: over.title,
      sev: 'P3',
      detail: `${over.title} detail`,
      plane: 'CENTRAL',
      state: 'open',
      age: '5m',
      tone: 'warning',
      siteId: 'campus-01',
      siteName: 'Campus-01 — Meridian HQ',
      ...over,
    }) as AlertRow;

  it('reads ages in the fixtures own vocabulary, and an unknown one as brand new', () => {
    expect(alertAgeMinutes('45s')).toBeCloseTo(0.75);
    expect(alertAgeMinutes('12m')).toBe(12);
    expect(alertAgeMinutes('6h')).toBe(360);
    expect(alertAgeMinutes('2d')).toBe(2880);
    // Not evidence of a long-running problem — so it must not outrank one.
    expect(alertAgeMinutes('unverified')).toBe(0);
    expect(compareAlerts(alert({ title: 'old', age: '2d' }), alert({ title: 'odd', age: 'unverified' }))).toBeLessThan(0);
  });

  it('returns null when nothing is open, so no banner renders', () => {
    expect(correlateAlerts([])).toBeNull();
    expect(correlateAlerts([alert({ title: 'Cleared', state: 'acked' })])).toBeNull();
  });

  it('names the worst open row even when it is not the first one', () => {
    const banner = correlateAlerts([
      alert({ title: 'Noisy radio', sev: 'P3' }),
      alert({ title: 'Gateway down', sev: 'P1', detail: 'no heartbeat for 6m' }),
      alert({ title: 'Port flapping', sev: 'P2' }),
    ]);
    expect(banner?.title).toBe('Gateway down');
    expect(banner?.tone).toBe('danger');
    expect(banner?.body).toContain('no heartbeat for 6m');
  });

  it('breaks a severity tie the way the queue does — oldest first', () => {
    const banner = correlateAlerts([
      alert({ title: 'Recent P1', sev: 'P1', age: '3m' }),
      alert({ title: 'Long-running P1', sev: 'P1', age: '4h' }),
    ]);
    expect(banner?.title).toBe('Long-running P1');
  });

  it('picks the WORST stale row as the second finding, not the first one it meets', () => {
    const banner = correlateAlerts([
      alert({ title: 'Gateway down', sev: 'P1' }),
      alert({ title: 'Cosmetic', sev: 'P3', plane: 'UXI', stale: true }),
      alert({ title: 'Radios offline', sev: 'P1', plane: 'MIST', stale: true }),
    ]);
    expect(banner?.title).toBe('Gateway down — and MIST is stale');
    expect(banner?.body).toContain('Radios offline');
  });

  it('prefers a stale row at the worst rows own site over a more severe one elsewhere', () => {
    const banner = correlateAlerts([
      alert({ title: 'Gateway down', sev: 'P1', siteId: 'campus-01' }),
      alert({ title: 'Elsewhere', sev: 'P1', plane: 'MIST', stale: true, siteId: 'campus-02' }),
      alert({ title: 'Same site', sev: 'P3', plane: 'UXI', stale: true, siteId: 'campus-01' }),
    ]);
    // Two findings about one site are a story; two about two sites are a list.
    expect(banner?.title).toBe('Gateway down — and UXI is stale');
  });

  it('says warning, not danger, when the worst open row is not a P1', () => {
    const banner = correlateAlerts([alert({ title: 'Port flapping', sev: 'P2' })]);
    expect(banner?.tone).toBe('warning');
    expect(banner?.title).toBe('Port flapping');
  });

  it('never crosses the worst row with itself', () => {
    const only = correlateAlerts([alert({ title: 'Gateway down', sev: 'P1', stale: true })]);
    expect(only?.title).toBe('Gateway down');
    expect(only?.body).not.toContain('Second finding');
  });
});

/**
 * One clock per screen.
 *
 * Twelve identical copies of this lived in web/src/screens and two more on the
 * server. The duplication was cosmetic; the split was not. A time the server
 * formatted was hh:mm in the server process's timezone and a time the browser
 * formatted was hh:mm in the reader's, and they rendered as the same four
 * digits and a colon on the same screen.
 */
describe('hhmmLocal', () => {
  it('renders an instant on the clock of whoever is reading it', () => {
    const at = new Date(2026, 6, 26, 14, 7, 3);
    expect(hhmmLocal(at.toISOString())).toBe('14:07');
  });

  it('leaves an already-rendered fixture time exactly as it was authored', () => {
    // Load-bearing: the demo rows carry '09:15' and the evidence trail uses
    // the literal 'now' for a row it is generating as you read it. Neither is
    // an instant, and neither needs improving.
    expect(hhmmLocal('09:15')).toBe('09:15');
    expect(hhmmLocal('now')).toBe('now');
    expect(hhmmLocal('—')).toBe('—');
  });

  it('keeps seconds when the screen is about bursts', () => {
    // Auth events exist to expose repeats; at minute precision six attempts
    // in four minutes are six identical strings.
    const at = new Date(2026, 6, 26, 9, 41, 22);
    expect(hhmmssLocal(at.toISOString())).toBe('09:41:22');
    expect(hhmmssLocal('09:41:22')).toBe('09:41:22');
  });

  it('agrees with itself across the two precisions', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5).toISOString();
    expect(hhmmssLocal(at).startsWith(hhmmLocal(at))).toBe(true);
  });
});
