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
 */

import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_ALERTS,
  PLANE_DATASET_KEYS,
  PLANE_ROW_DATASET_KEYS,
  UNKNOWN_LANE_META,
  deviceTerminalKind,
  isRealSiteId,
  laneSyncStamp,
  planeStaleness,
  ssidPreview,
  staleAfterSecFor,
  type ConfigInventory,
  type SsidForm,
  type SubscriptionAssignment,
} from '../../shared';
import type { PlanePull, PlaneState } from '../src/planes/types';

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
