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
 *   - The ClearPass policy inventories (networkDevices…deviceGroups): the new
 *     PlanePull dataset keys are ClearPass-only (never row-merged), and the
 *     demo ClearPass world stays internally consistent — NADs are the demo
 *     estate's own switches, policies resolve to profiles resolve to roles,
 *     services name real auth sources and real NAD addresses, and no fixture
 *     carries local-user or service secret material.
 */

import { describe, expect, it } from 'vitest';
import {
  AP_TREND_METRICS,
  AP_TRENDS_DEMO,
  CLEARPASS_AUTH_SOURCES,
  CLEARPASS_ENDPOINTS,
  CLEARPASS_ENFORCEMENT_POLICIES,
  CLEARPASS_ENFORCEMENT_PROFILES,
  CLEARPASS_LOCAL_USERS,
  CLEARPASS_NETWORK_DEVICES,
  CLEARPASS_ROLES,
  CLEARPASS_SERVICES,
  CLEARPASS_SERVICE_DETAILS,
  CLIENTS,
  DEVICES,
  DPI_BYTES_ARE_ESTIMATES,
  MIST_AP_STATS,
  MIST_LICENSE_USAGES,
  MIST_SITE_MAPS,
  MIST_SLE_DRILLDOWN,
  OVERVIEW_ALERTS,
  PLANE_DATASET_KEYS,
  PLANE_ROW_DATASET_KEYS,
  RISK_BUCKET_ORDER,
  SITES,
  SITE_APPLICATIONS_DEMO,
  SITE_SLE,
  SSE_LIMITED_RELEASE_KINDS,
  SSE_OBJECT_KINDS,
  SSE_OBJECT_KIND_LABELS,
  SSIDS,
  SWITCH_HARDWARE_TRENDS_DEMO,
  SWITCH_HARDWARE_TREND_KEYS,
  SWITCH_INTERFACE_TRENDS_DEMO,
  TREND_WINDOW_MAX_MS,
  UNKNOWN_LANE_META,
  alertAgeMinutes,
  byBytesDesc,
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
  mistSsidSecurityRefusal,
  normalizeRiskBucket,
  normalizeTrendSet,
  normalizeTrendWindow,
  planeKeyOf,
  planeStaleness,
  planeSupportsClientField,
  rollupAppCategories,
  ssidDependencyRequirementsFor,
  ssidPreview,
  watchlistSplit,
  hhmmLocal,
  hhmmssLocal,
  localDayKey,
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

describe('ClearPass policy inventories — dataset keys, the pull shape and the demo world', () => {
  const INVENTORY_KEYS = [
    'networkDevices',
    'authSources',
    'roles',
    'enforcementPolicies',
    'enforcementProfiles',
    'localUsers',
    'services',
    'deviceGroups',
  ] as const;

  it('joins the dataset keys as ClearPass-only datasets, never row-merged', () => {
    for (const key of INVENTORY_KEYS) {
      expect(PLANE_DATASET_KEYS).toContain(key);
      expect(PLANE_ROW_DATASET_KEYS).not.toContain(key as never);
    }
  });

  it('a pull can carry every inventory dataset and name an unread one', () => {
    const pull: PlanePull = {
      authEvents: [],
      networkDevices: [
        {
          id: '501',
          name: 'sw-core-a',
          ipAddress: '10.42.8.11',
          vendorName: 'Aruba',
          coaCapable: true,
          radsecEnabled: false,
          description: 'Campus-01 core',
        },
      ],
      authSources: [{ id: '7', name: 'AD meridian.health', type: 'Active Directory', description: null }],
      roles: [{ id: '3', name: 'Clinical staff', description: 'vlan 820' }],
      enforcementPolicies: [
        { id: '9', name: 'MRDN Wireless 802.1X Enforcement', enforcementType: 'RADIUS', defaultProfile: 'Quarantine' },
      ],
      enforcementProfiles: [{ id: '2', name: 'Guest', type: 'RADIUS', description: 'vlan 812' }],
      localUsers: [{ id: '21', userId: 'portal-collector', username: null, roleName: 'read-only shell', enabled: true }],
      // services/deviceGroups absent — this CPPM does not expose them (404,
      // honest absence, so NOT named in partial either).
    };
    expect(pull.networkDevices).toHaveLength(1);
    expect(pull.services).toBeUndefined();
    expect(pull.deviceGroups).toBeUndefined();
    const failing: PlanePull = { authEvents: [], partial: ['roles'] };
    expect(failing.partial).toEqual(['roles']);
    expect(pull.localUsers![0]).not.toHaveProperty('password');
  });

  it('the demo NADs are the demo estate’s own switches, with management IPs', () => {
    expect(CLEARPASS_NETWORK_DEVICES.map((n) => n.name)).toEqual(['sw-core-a', 'sw-acc-3f-2', 'sw-cam02-1']);
    expect(DEVICES.map((d) => d.name)).toEqual(expect.arrayContaining(CLEARPASS_NETWORK_DEVICES.map((n) => n.name)));
    for (const nad of CLEARPASS_NETWORK_DEVICES) {
      expect(nad.ipAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(nad.coaCapable).toBe(true); // a NAD that cannot take a CoA breaks the demo's disconnect story
    }
    // sw-cam02-1 is the RadSec client the 'RadSec certificate expires' alert is about
    expect(CLEARPASS_NETWORK_DEVICES.find((n) => n.name === 'sw-cam02-1')?.radsecEnabled).toBe(true);
  });

  it('the demo auth sources are the two the auth feed’s reasons name', () => {
    expect(CLEARPASS_AUTH_SOURCES.map((s) => s.name)).toEqual(['AD meridian.health', 'Local User Repository']);
    expect(CLEARPASS_AUTH_SOURCES.map((s) => s.type)).toEqual(['Active Directory', 'Local']);
  });

  it('the demo policy chain resolves: policies → default profiles → roles', () => {
    const profileNames = CLEARPASS_ENFORCEMENT_PROFILES.map((p) => p.name);
    const roleNames = CLEARPASS_ROLES.map((r) => r.name);
    expect(CLEARPASS_ENFORCEMENT_POLICIES.map((p) => p.enforcementType)).toEqual(['RADIUS', 'WEBAUTH']);
    for (const policy of CLEARPASS_ENFORCEMENT_POLICIES) {
      expect(profileNames).toContain(policy.defaultProfile);
    }
    // every demo enforcement profile is a role the box could actually apply
    for (const profile of profileNames) {
      expect(roleNames).toContain(profile);
    }
  });

  it('the demo local users carry exactly the whitelisted fields — no password lives in this world either', () => {
    expect(CLEARPASS_LOCAL_USERS.length).toBeGreaterThan(0);
    for (const u of CLEARPASS_LOCAL_USERS) {
      expect(Object.keys(u).sort()).toEqual(['enabled', 'id', 'roleName', 'userId', 'username']);
      expect(JSON.stringify(u)).not.toMatch(/password|hash|secret|\$2[aby]\$/i);
      expect(u.userId).toBeTruthy();
    }
  });

  it('the demo services name real auth sources and NAD addresses — and carry no credential material', () => {
    const sourceNames = CLEARPASS_AUTH_SOURCES.map((s) => s.name);
    const nadIps = CLEARPASS_NETWORK_DEVICES.map((n) => n.ipAddress);
    expect(CLEARPASS_SERVICES.length).toBeGreaterThan(0);
    for (const s of CLEARPASS_SERVICES) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      // auth sources resolve to the box's reported sources (eduroam names
      // none — it proxies to the home IdP, an honest omission)
      for (const src of s.authSources ?? []) {
        expect(sourceNames).toContain(src);
      }
      // a NAD-IP match rule points at the demo estate's own NADs
      for (const m of s.rulesSummary?.matchAll(/NAD-IP-Address \w+ ([\d.]+)/g) ?? []) {
        expect(nadIps).toContain(m[1]);
      }
      // the summary is the readable line the mapper would build — never raw JSON
      if (s.rulesSummary != null) {
        expect(s.rulesSummary).not.toMatch(/[{}[\]"]/);
      }
      // nothing in a service row is credential material, in this world either
      expect(JSON.stringify(s)).not.toMatch(/password|hash|secret|\$2[aby]\$/i);
    }
    // the one disabled service is the eduroam pilot — a 0-hit row, so the
    // tab shows an honest Disabled badge next to working services
    const disabled = CLEARPASS_SERVICES.filter((s) => s.enabled === false);
    expect(disabled.map((s) => s.name)).toEqual(['eduroam 802.1X']);
    expect(disabled[0].hitCount).toBe(0);
  });

  it('the demo service detail deepens its collection row, names real entities, and carries no credential material', () => {
    // One authored detail per key, keyed by a service the demo CPPM actually
    // reports — a fixture for an unreported id would be invention.
    const sourceNames = CLEARPASS_AUTH_SOURCES.map((s) => s.name);
    const policyNames = CLEARPASS_ENFORCEMENT_POLICIES.map((p) => p.name);
    expect(Object.keys(CLEARPASS_SERVICE_DETAILS)).toEqual(['svc-001']);
    for (const [id, detail] of Object.entries(CLEARPASS_SERVICE_DETAILS)) {
      const row = CLEARPASS_SERVICES.find((s) => s.id === id);
      expect(row, `detail fixture '${id}' has no collection row`).toBeTruthy();
      expect(detail.service).not.toBeNull();
      const s = detail.service!;
      // the detail is the row's own story, deepened — identity, state, order
      // and hit count agree, and the drawer never contradicts the tab
      expect(s.id).toBe(row!.id);
      expect(s.name).toBe(row!.name);
      expect(s.enabled).toBe(row!.enabled ?? null);
      expect(s.hitCount).toBe(row!.hitCount ?? null);
      expect(s.orderNo).toBe(row!.orderNo ?? null);
      // auth sources resolve to the box's reported sources; the enforcement
      // policy resolves to a reported policy — plain text, but REAL text
      for (const src of s.authSources) expect(sourceNames).toContain(src);
      if (s.enforcementPolicy !== null) expect(policyNames).toContain(s.enforcementPolicy);
      // match conditions are the rule editor's rows — never raw JSON
      for (const c of s.rulesConditions) {
        for (const field of [c.type, c.name, c.operator, c.value]) {
          if (field !== null) expect(field).not.toMatch(/[{}[\]"]/);
        }
      }
      // the provenance envelope is present and says the read succeeded
      expect(detail.source.plane).toBe('clearpass');
      expect(detail.source.sections.service).toBe('ok');
      // nothing in a service definition is credential material, in this world either
      expect(JSON.stringify(detail)).not.toMatch(/password|hash|secret|\$2[aby]\$/i);
    }
  });

  it('demo endpoint insightTags are profiler evidence, never a copy of the enforcement profile', () => {
    const tagged = CLEARPASS_ENDPOINTS.filter((e) => e.insightTags !== undefined);
    expect(tagged.length).toBeGreaterThan(0); // the demo has profiled devices
    expect(tagged.length).toBeLessThan(CLEARPASS_ENDPOINTS.length); // …and unprofiled ones
    for (const e of tagged) {
      expect(e.insightTags!.length).toBeGreaterThan(0); // present means non-empty
      expect(e.insightTags).not.toContain(e.profile);
    }
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

  it('a Mist-targeted form has NO Central dependency catalogs — only the write-only passphrase remains', () => {
    // The role/server-group/portal gates are New Central constructs; Mist has
    // no such catalogs, so nothing can be "required" of them there.
    expect(ssidDependencyRequirementsFor('wpa2-psk', 'MIST')).toEqual({
      role: false,
      authServerGroup: false,
      captivePortal: false,
      passphrase: true,
    });
    for (const security of ['wpa3-enterprise', 'wpa2-enterprise', 'psk-portal', 'open'] as const) {
      expect(ssidDependencyRequirementsFor(security, 'MIST')).toEqual({
        role: false,
        authServerGroup: false,
        captivePortal: false,
        passphrase: false,
      });
    }
    // The Central rules are untouched, and an unplaceable label falls back to them.
    expect(ssidDependencyRequirementsFor('wpa2-enterprise', 'CENTRAL').authServerGroup).toBe(true);
    expect(ssidDependencyRequirementsFor('wpa2-psk', 'CENTRAL + MIST').passphrase).toBe(true);
  });

  it('mistSsidSecurityRefusal names exactly the modes Mist cannot express — and clears the two it can', () => {
    expect(mistSsidSecurityRefusal('wpa2-psk')).toBeNull();
    expect(mistSsidSecurityRefusal('open')).toBeNull();
    expect(mistSsidSecurityRefusal('psk-portal')).toMatch(/portal/i);
    expect(mistSsidSecurityRefusal('wpa2-enterprise')).toMatch(/RADIUS/);
    expect(mistSsidSecurityRefusal('wpa3-enterprise')).toMatch(/RADIUS/);
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

/**
 * One "today".
 *
 * The per-plane call counter has always rolled at local midnight. The
 * Configure "Pushed today" tile decided the day with a UTC slice. Both said
 * "today", on the same portal, and west of Greenwich they meant different
 * days for part of every afternoon.
 */
describe('localDayKey', () => {
  it('answers on the host clock, not UTC', () => {
    // 23:30 on the 26th, local. A UTC slice of this instant reads as the 26th
    // or the 27th depending only on where the host is standing; the calendar
    // on the wall says the 26th.
    const late = new Date(2026, 6, 26, 23, 30, 0);
    expect(localDayKey(late)).toBe('2026-07-26');
    expect(localDayKey(late.toISOString())).toBe('2026-07-26');
  });

  it('puts an instant and the moment it happened in the same bucket', () => {
    // The whole point: a stamp written now must land in the day it is now.
    expect(localDayKey(new Date().toISOString())).toBe(localDayKey());
  });

  it('gives a non-instant a key no real day can collide with', () => {
    expect(localDayKey('not-a-date')).toBe('—');
    expect(localDayKey('')).toBe('—');
  });

  it('rolls at local midnight, not seventeen hours before or after it', () => {
    const endOfDay = new Date(2026, 6, 26, 23, 59, 59);
    const startOfNext = new Date(2026, 6, 27, 0, 0, 0);
    expect(localDayKey(endOfDay)).toBe('2026-07-26');
    expect(localDayKey(startOfNext)).toBe('2026-07-27');
  });
});

/**
 * The demo world's Mist data demonstrates exactly what the live adapter now
 * reads: per-site SLE with classifiers/impact, at/behind firmware verdicts,
 * claim codes, per-site licence usage, and the PSK-redaction marker on SSIDs.
 * These tests pin the invariants that keep the demo honest — the same rules
 * the adapter's own mapping tests enforce on the live path.
 */
describe('demo Mist fixtures — deterministic, honest, and matching the live read', () => {
  it('SITE_SLE covers exactly the sites the SITES rows badge as MIST', () => {
    const mistSites = SITES.filter((s) => s.planes.some((p) => p.name === 'MIST')).map((s) => s.id);
    expect(Object.keys(SITE_SLE).sort()).toEqual(mistSites.sort());
  });

  it('SITE_SLE headline fractions are the same numbers the metrics derive to', () => {
    for (const row of Object.values(SITE_SLE)) {
      expect(row?.metrics?.length).toBeGreaterThan(0);
      const byMetric = new Map(row?.metrics?.map((m) => [m.name, m.success]));
      // The headline columns read the matching metric's success fraction.
      expect(row?.coverage).toBe(byMetric.get('coverage') ?? null);
      expect(row?.capacity).toBe(byMetric.get('capacity') ?? null);
      expect(row?.roaming).toBe(byMetric.get('roaming') ?? null);
      expect(row?.apHealth).toBe(byMetric.get('ap-health') ?? null);
      // Every fraction is a real 0–1 value or an honest null, and overall is
      // the mean of the dimensions present (the adapter's own rule).
      for (const m of row?.metrics ?? []) {
        if (m.success !== null) {
          expect(m.success).toBeGreaterThanOrEqual(0);
          expect(m.success).toBeLessThanOrEqual(1);
          // success is derived from counts: 1 − degraded/samples (the
          // authored fractions are 2-dp display values, so the check is to
          // display precision).
          if (m.samples !== null && m.degraded !== null && m.samples > 0) {
            expect(m.success).toBeCloseTo(1 - m.degraded / m.samples, 2);
          }
        }
        for (const c of m.classifiers) expect(c.name.length).toBeGreaterThan(0);
      }
      const present = [row?.coverage, row?.capacity, row?.roaming, row?.apHealth, row?.wan].filter(
        (v): v is number => v !== null && v !== undefined,
      );
      expect(row?.overall).toBeCloseTo(present.reduce((a, b) => a + b, 0) / present.length, 10);
    }
  });

  it('demo Mist devices carry claim codes and a real at/behind firmware spread', () => {
    const mist = DEVICES.filter((d) => d.plane === 'MIST');
    expect(mist.length).toBeGreaterThan(0);
    for (const d of mist) expect(d.claimCode).toMatch(/^[A-Z0-9]{15}$/);
    // ap-3f-14 is the authored "behind" row: false is only ever stamped with
    // the recommended train it is behind, and the plane's own state word.
    const behind = mist.find((d) => !d.firmwareApproved);
    expect(behind).toMatchObject({ firmwareTarget: expect.any(String), firmwareUpdate: expect.any(String) });
    // …and at least one row sits exactly on its recommended train.
    expect(mist.some((d) => d.firmwareApproved && d.firmware === '0.14.29')).toBe(true);
  });

  it('MIST_LICENSE_USAGES attributes usage only to real sites, with sane counts', () => {
    expect(MIST_LICENSE_USAGES.length).toBeGreaterThan(0);
    for (const row of MIST_LICENSE_USAGES) {
      expect(isRealSiteId(row.siteId)).toBe(true);
      expect(row.numAps).not.toBeNull();
      expect(row.numDevices).not.toBeNull();
      expect(row.numAps!).toBeLessThanOrEqual(row.numDevices!);
      expect(row.usages).not.toBeNull();
      for (const [service, count] of Object.entries(row.usages ?? {})) {
        expect(service).toMatch(/^SUB-/);
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('every PSK SSID says the key exists and is redacted — and no fixture carries one', () => {
    const pskRows = SSIDS.filter((s) => /psk/i.test(s.security));
    expect(pskRows.length).toBeGreaterThan(0);
    for (const row of pskRows) expect(row.note).toContain('redacted by the portal');
    // The fixtures must never model the secret itself: no key anywhere on an
    // SSID row smells like a passphrase (the note/security text aside).
    for (const row of SSIDS) {
      for (const [key, value] of Object.entries(row)) {
        expect(key).not.toMatch(/psk|secret|passphrase|password/i);
        if (key !== 'note' && key !== 'security') expect(String(value)).not.toMatch(/cleartext/i);
      }
    }
  });

  it('MIST_AP_STATS authors real Mist APs at real sites, with sane readings and a real LLDP edge', () => {
    expect(MIST_AP_STATS.length).toBeGreaterThan(0);
    const deviceByName = new Map(DEVICES.map((d) => [d.name, d]));
    for (const row of MIST_AP_STATS) {
      expect(isRealSiteId(row.siteId)).toBe(true);
      // Every authored stats row stands behind a real MIST AP at the same site.
      const device = deviceByName.get(row.deviceName);
      expect(device, row.deviceName).toBeDefined();
      expect(device).toMatchObject({ plane: 'MIST', type: 'ap', siteId: row.siteId });
      expect(row.radios.length).toBeGreaterThan(0);
      for (const radio of row.radios) {
        for (const pct of [radio.utilAllPct, radio.utilTxPct, radio.utilRxInBssPct, radio.utilRxOtherBssPct, radio.utilNonWifiPct]) {
          if (pct !== null) {
            expect(pct).toBeGreaterThanOrEqual(0);
            expect(pct).toBeLessThanOrEqual(100);
          }
        }
      }
      // The radio client counts never exceed the row's own total.
      const radioSum = row.radios.reduce((sum, r) => sum + (r.numClients ?? 0), 0);
      if (row.numClients !== null && row.radios.every((r) => r.numClients !== null)) {
        expect(radioSum).toBeLessThanOrEqual(row.numClients);
      }
    }
    // The LLDP uplink the topology edges are built from: at least one row
    // uplinks to a switch that exists in the demo inventory.
    const uplinks = MIST_AP_STATS.map((r) => r.lldpUplink?.systemName).filter((n): n is string => !!n);
    expect(uplinks.length).toBeGreaterThan(0);
    expect(uplinks.some((name) => deviceByName.get(name)?.type === 'switch')).toBe(true);
  });

  it('MIST_SITE_MAPS authors a renderable plan: real site, placed APs inside the image, an SVG that matches its dims', () => {
    expect(MIST_SITE_MAPS.length).toBeGreaterThan(0);
    const deviceByName = new Map(DEVICES.map((d) => [d.name, d]));
    const mistSites = SITES.filter((s) => s.planes.some((p) => p.name === 'MIST')).map((s) => s.id);
    for (const map of MIST_SITE_MAPS) {
      expect(mistSites).toContain(map.siteId);
      expect(map.imageUrl).toMatch(/^data:image\/svg\+xml/);
      const svg = decodeURIComponent(map.imageUrl ?? '');
      expect(svg).toContain('<svg');
      // The inline image's own viewBox agrees with the stated pixel dims.
      expect(svg).toContain(`viewBox="0 0 ${map.widthPx} ${map.heightPx}"`);
      for (const ap of map.aps) {
        const device = deviceByName.get(ap.deviceName);
        expect(device, ap.deviceName).toBeDefined();
        expect(device).toMatchObject({ plane: 'MIST', type: 'ap', siteId: map.siteId });
        expect(ap.x).toBeGreaterThanOrEqual(0);
        expect(ap.x).toBeLessThanOrEqual(map.widthPx!);
        expect(ap.y).toBeGreaterThanOrEqual(0);
        expect(ap.y).toBeLessThanOrEqual(map.heightPx!);
      }
      // Meters and pixels tell the same story (the renderer's scale factor).
      expect(map.widthM!).toBeGreaterThan(0);
      expect(map.heightM!).toBeGreaterThan(0);
    }
  });

  it('client map dots reference an authored map, inside its image, for the site the client is at', () => {
    const dotted = CLIENTS.filter((c) => c.mapId !== undefined);
    expect(dotted.length).toBeGreaterThan(0);
    for (const c of dotted) {
      // A dot is all three or nothing — the partial position never ships.
      expect(c.x).toBeDefined();
      expect(c.y).toBeDefined();
      const map = MIST_SITE_MAPS.find((m) => m.mapId === c.mapId);
      expect(map, `${c.name} → ${c.mapId}`).toBeDefined();
      expect(map?.siteId).toBe(c.siteId);
      expect(c.x!).toBeLessThanOrEqual(map!.widthPx!);
      expect(c.y!).toBeLessThanOrEqual(map!.heightPx!);
    }
  });

  it('the demo Mist wired roster is wired-medium rows attached to a real switch at the site', () => {
    const wired = CLIENTS.filter((c) => c.plane === 'MIST' && c.medium === 'wired');
    expect(wired.length).toBeGreaterThanOrEqual(2); // the NEW medium must be showcased
    const deviceByName = new Map(DEVICES.map((d) => [d.name, d]));
    for (const c of wired) {
      expect(isRealSiteId(c.siteId)).toBe(true);
      const sw = deviceByName.get(c.attach);
      expect(sw, `${c.name} attach`).toBeDefined();
      expect(sw).toMatchObject({ type: 'switch', siteId: c.siteId });
      // No wireless readings are authored on a wired row.
      expect(c.rssi).toBe('—');
      expect(c.snr).toBe('—');
      expect(c.roams).toBe('0');
    }
  });

  it('MIST_SLE_DRILLDOWN agrees with SITE_SLE, names real clients/APs, and is deterministic', () => {
    const keys = Object.keys(MIST_SLE_DRILLDOWN);
    expect(keys.length).toBeGreaterThan(0);
    const clientMacs = new Set(CLIENTS.map((c) => c.mac));
    const deviceNames = new Set(DEVICES.map((d) => d.name));
    for (const [key, detail] of Object.entries(MIST_SLE_DRILLDOWN)) {
      // The key is `${siteId}|${metric}` — the way the adapter is called.
      expect(key).toBe(`${detail.siteId}|${detail.metric}`);
      expect(isRealSiteId(detail.siteId)).toBe(true);
      const sle = SITE_SLE[detail.siteId];
      expect(sle, detail.siteId).toBeDefined();
      // The drill-down's classifiers are the ones the polled summary carries —
      // a drill that disagreed with the headline would be its own lie.
      const summaryClassifiers = new Set(
        (sle?.metrics ?? []).find((m) => m.name === detail.metric)?.classifiers.map((c) => c.name) ?? [],
      );
      for (const c of detail.classifiers ?? []) expect(summaryClassifiers, c.name).toContain(c.name);
      // Impacted clients/APs are the demo world's own rows.
      for (const u of detail.impactedClients ?? []) {
        expect(clientMacs, u.mac).toContain(u.mac);
        if (u.name !== null) expect(CLIENTS.find((c) => c.mac === u.mac)?.name).toBe(u.name);
      }
      for (const ap of detail.impactedAps ?? []) {
        if (ap.name !== null) expect(deviceNames, ap.name).toContain(ap.name);
      }
      // Trend series are parallel and bounded by the window they claim.
      const trend = detail.trend;
      expect(trend).toBeDefined();
      expect(trend!.total.length).toBe(trend!.degraded.length);
      expect(trend!.endSec! - trend!.startSec!).toBe(trend!.intervalSec! * trend!.total.length);
      // Determinism: the stamp is a fixed authored instant, not a clock read.
      expect(new Date(detail.source.at).toISOString()).toBe(detail.source.at);
    }
  });
});

// ---------------------------------------------------------------------------
// DPI application visibility + hardware trends (shared/appRisk.ts,
// shared/trends.ts, the demo fixtures behind the Central on-demand readers).
// ---------------------------------------------------------------------------

describe('DPI + hardware trends contracts', () => {
  const DPI_NOW = Date.parse('2026-07-26T12:00:00.000Z');

  it('the risk vocabulary is worst-first, alias-folded and idempotent', () => {
    expect(RISK_BUCKET_ORDER).toEqual(['suspicious', 'moderate', 'low', 'trustworthy', 'unknown']);
    const aliases: [string, string][] = [
      ['high', 'suspicious'],
      ['very_high', 'suspicious'],
      ['medium', 'moderate'],
      ['very_low', 'low'],
      ['trusted', 'trustworthy'],
      ['safe', 'trustworthy'],
      ['not_evaluated', 'unknown'],
    ];
    for (const [word, bucket] of aliases) {
      expect(normalizeRiskBucket(word)).toBe(bucket);
      // Idempotent: normalizing a normalized row changes nothing.
      expect(normalizeRiskBucket(normalizeRiskBucket(word))).toBe(bucket);
    }
    for (const bucket of RISK_BUCKET_ORDER) expect(normalizeRiskBucket(bucket)).toBe(bucket);
  });

  it('the DPI byte honesty caveat is pinned verbatim', () => {
    expect(DPI_BYTES_ARE_ESTIMATES).toBe('DPI byte totals are estimates — read as a ranking, not a measurement');
  });

  it('the window validator enforces the endpoint 7-day cap', () => {
    expect(normalizeTrendWindow('2026-07-25T12:00:00Z', '2026-07-26T12:00:00Z').ok).toBe(true);
    expect(normalizeTrendWindow('2026-07-18T12:00:00Z', '2026-07-26T12:00:00Z').ok).toBe(false); // 8 days
    expect(normalizeTrendWindow('2026-07-26T12:00:00Z', '2026-07-25T12:00:00Z').ok).toBe(false); // inverted
    expect(normalizeTrendWindow('junk', '2026-07-26T12:00:00Z').ok).toBe(false);
  });

  it('the trend normalizer is pure — same payload, same TrendSet', () => {
    const samples = [
      { timestamp: 1_785_000_000_000, data: ['14', '800'] },
      { timestamp: 1_785_000_060_000, data: ['15', '1400'] },
    ];
    const a = normalizeTrendSet(['cpuUtilization', 'inErrors'], samples, { inErrors: { kind: 'counter' } });
    const b = normalizeTrendSet(['cpuUtilization', 'inErrors'], samples, { inErrors: { kind: 'counter' } });
    expect(a).toEqual(b);
  });

  it('SITE_APPLICATIONS_DEMO is a real site, ranked, with both watchlist kinds and dead fields nulled', () => {
    const keys = Object.keys(SITE_APPLICATIONS_DEMO);
    expect(keys.length).toBeGreaterThan(0);
    for (const [siteId, live] of Object.entries(SITE_APPLICATIONS_DEMO)) {
      expect(isRealSiteId(siteId)).toBe(true);
      expect(live).toBeDefined();
      expect(live!.siteId).toBe(siteId);
      expect(live!.source.plane).toBe('central');
      expect(live!.source.sections.apps).toBe('ok');
      // The window is inside the endpoint's 7-day cap.
      const span = Date.parse(live!.window.end) - Date.parse(live!.window.start);
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(TREND_WINDOW_MAX_MS);
      const apps = live!.apps ?? [];
      expect(apps.length).toBeGreaterThan(0);
      // Ranked by bytes: re-sorting changes nothing.
      expect(apps.map((a) => a.name)).toEqual(byBytesDesc(apps).map((a) => a.name));
      // Both watchlist kinds are showcased: flagged-known AND flagged-unclassified.
      const split = watchlistSplit(apps);
      expect(split.unclassified.length).toBeGreaterThan(0);
      expect(split.known.length).toBeGreaterThan(0);
      for (const a of split.unclassified) expect(['suspicious', 'moderate']).toContain(a.risk);
      // The verified dead fields are null on every row — the demo never fakes them.
      for (const a of apps) {
        expect(a.experience).toBeNull();
        expect(a.tlsVersion).toBeNull();
        expect(a.certificateExpiryAt).toBeNull();
        expect(a.riskRaw.length).toBeGreaterThan(0);
        if (a.lastUsedAt !== null) expect(Date.parse(a.lastUsedAt)).toBeLessThanOrEqual(DPI_NOW);
      }
      // The rollup over the demo table: the largest bar is exactly 1 and no
      // share exceeds it — share-of-largest, never percent-of-total.
      const rolled = rollupAppCategories(apps);
      expect(rolled.length).toBeGreaterThan(0);
      expect(rolled[0]!.share).toBe(1);
      for (const r of rolled) {
        expect(r.share).toBeGreaterThanOrEqual(0);
        expect(r.share).toBeLessThanOrEqual(1);
        expect(r.apps).toBeGreaterThan(0);
      }
      // Determinism: a fixed authored stamp, not a clock read.
      expect(new Date(live!.source.at).toISOString()).toBe(live!.source.at);
    }
  });

  it('the demo hardware trends belong to a real demo switch and tell its degraded story', () => {
    const keys = Object.keys(SWITCH_HARDWARE_TRENDS_DEMO);
    expect(keys.length).toBeGreaterThan(0);
    for (const [key, live] of Object.entries(SWITCH_HARDWARE_TRENDS_DEMO)) {
      const device = DEVICES.find((d) => d.name === key);
      expect(device, key).toBeDefined();
      expect(device!.type).toBe('switch');
      expect(live.serial).toBe(key); // demo devices carry no serial — keyed by name
      expect(live.source.plane).toBe('central');
      expect(live.source.sections.hardware).toBe('ok');
      const set = live.trends!;
      expect(set.ok).toBe(true);
      expect(set.series.map((s) => s.key)).toEqual([...SWITCH_HARDWARE_TREND_KEYS]);
      for (const s of set.series) {
        expect(s.kind).toBe('gauge');
        expect(s.bucketMs).toBe(3_600_000);
        for (const p of s.points) expect(new Date(p.t).toISOString()).toBe(p.t);
      }
      // The outage is a break, not a bridge: the gap marker exists on every series.
      const cpu = set.series[0]!;
      expect(cpu.points.some((p) => p.v === null)).toBe(true);
      for (const p of cpu.points) {
        if (p.v !== null) {
          expect(p.v).toBeGreaterThanOrEqual(0);
          expect(p.v).toBeLessThanOrEqual(100);
        }
      }
      // PoE bookkeeping: total >= device power + PoE draw on every reported bucket.
      const byKey = new Map(set.series.map((s) => [s.key, s]));
      const total = byKey.get('totalPowerConsumption')!;
      const deviceW = byKey.get('powerConsumption')!;
      const poeW = byKey.get('poeConsumption')!;
      for (let i = 0; i < total.points.length; i += 1) {
        const t = total.points[i]!.v;
        const dW = deviceW.points[i]!.v;
        const pW = poeW.points[i]!.v;
        if (t !== null && dW !== null && pW !== null) expect(t).toBeGreaterThanOrEqual(dW + pW);
      }
      // The window is inside the cap and the stamp is fixed.
      const span = Date.parse(live.window.end) - Date.parse(live.window.start);
      expect(span).toBeLessThanOrEqual(TREND_WINDOW_MAX_MS);
      expect(new Date(live.source.at).toISOString()).toBe(live.source.at);
    }
  });

  it('the demo AP trends are per-metric, keyed like the adapter call, and throughput is a real bit/s rate', () => {
    const keys = Object.keys(AP_TRENDS_DEMO);
    expect(keys.length).toBeGreaterThan(0);
    for (const [key, live] of Object.entries(AP_TRENDS_DEMO)) {
      expect(key).toBe(`${live.serial}|${live.metric}`);
      const device = DEVICES.find((d) => d.name === live.serial);
      expect(device, live.serial).toBeDefined();
      expect(device!.type).toBe('ap');
      expect(device!.plane).toBe('CENTRAL'); // the only plane with this read
      expect(AP_TREND_METRICS).toContain(live.metric);
      expect(live.source.sections.trends).toBe('ok');
      const series = live.trends!.series[0]!;
      expect(series.bucketMs).toBe(3_600_000);
      if (live.metric === 'throughput') {
        expect(series.kind).toBe('bucket-total');
        expect(series.rate).toBe('bits-per-second');
        for (const p of series.points) if (p.v !== null) expect(p.v).toBeGreaterThan(0);
      } else {
        expect(series.kind).toBe('gauge');
        expect(series.rate).toBeNull();
      }
      expect(new Date(live.source.at).toISOString()).toBe(live.source.at);
    }
  });

  it('the demo interface trends convert counters to rates and keep the CRC story', () => {
    const keys = Object.keys(SWITCH_INTERFACE_TRENDS_DEMO);
    expect(keys.length).toBeGreaterThan(0);
    for (const [key, live] of Object.entries(SWITCH_INTERFACE_TRENDS_DEMO)) {
      const device = DEVICES.find((d) => d.name === key);
      expect(device, key).toBeDefined();
      expect(device!.type).toBe('switch');
      const set = live.trends!;
      expect(set.ok).toBe(true);
      const tx = set.series.find((s) => s.key === 'txBytes')!;
      expect(tx.kind).toBe('counter');
      expect(tx.rate).toBe('bits-per-second');
      expect(tx.points[0]!.v).toBeNull(); // the first sample has no predecessor
      // Rates stay sane for a 10G core uplink (between 1 and 10 Gbit/s).
      for (const p of tx.points) {
        if (p.v !== null) {
          expect(p.v).toBeGreaterThan(1e9);
          expect(p.v).toBeLessThan(1e10);
        }
      }
      const crc = set.series.find((s) => s.key === 'inCrcErrors')!;
      expect(crc.kind).toBe('counter');
      expect(crc.points.some((p) => p.v !== null && p.v > 0)).toBe(true); // the excursion burst exists
      const span = Date.parse(live.window.end) - Date.parse(live.window.start);
      expect(span).toBeLessThanOrEqual(TREND_WINDOW_MAX_MS);
      expect(new Date(live.source.at).toISOString()).toBe(live.source.at);
    }
  });
});
