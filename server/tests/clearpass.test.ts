/**
 * server/tests/clearpass.test.ts — ClearPass adapter unit tests, NO network.
 *
 * The mapping helpers are tested against recorded ClearPass auth JSON inlined
 * here (Insight, /api/session accounting and legacy shapes, shape variance on
 * purpose); ClearPassAdapter.pull() is exercised end-to-end with an in-memory
 * fake `fetch` (FetchLike injection) to cover OAuth token minting and the 401
 * refresh, the HAL (_embedded.items) envelope, the windowed/paged request,
 * candidate-path fallback with a remembered working path, the newest-200 cap,
 * the endpoint-count fact, error naming and the secret-free call log. The
 * endpoint-repository mapper (attributes nesting, updated_at fallback,
 * description, device_insight_tags) and the policy-inventory datasets (NADs,
 * auth sources, roles, enforcement policies/profiles, local users, services,
 * device groups) are covered the same way — including per-dataset failure
 * isolation, the services path candidates (/api/config/service first on
 * 6.11+, /api/service as the pre-6.11 fallback — only BOTH 404ing is honest
 * absence, the rule /api/device-group keeps on its single path), and the
 * local-user whitelist (no password hash crosses). The reviewed direct writes
 * (endpoint register/update, local-user create/update) are covered at the
 * adapter level too — payload shape, the read-back verify tri-state, refusal
 * reporting, write-triggered cache invalidation, and the password discipline
 * (the outbound request body and nowhere else).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import {
  ClearPassAdapter,
  MAX_AUTH_EVENTS,
  authMethodFor,
  authResultFor,
  mapClearPassAuthEvent,
  mapClearPassAuthSource,
  mapClearPassDeviceGroup,
  mapClearPassEndpoint,
  mapClearPassEnforcementPolicy,
  mapClearPassEnforcementProfile,
  mapClearPassLocalUser,
  mapClearPassNetworkDevice,
  mapClearPassRole,
  mapClearPassService,
  mapClearPassServiceDetail,
  normalizeMac,
  summarizeServiceRules,
} from '../src/planes/clearpass';
import {
  type FetchLike,
} from '../src/planes/transport';

// -- Recorded fixtures (Insight and legacy shapes, mixed on purpose) ------------

const ROW_ACCEPT = {
  id: 'log-1',
  timestamp: '2026-07-25T09:41:22Z',
  username: 'm.okonjo',
  mac_address: '3C-22-FB-41-0A-19',
  service_name: 'MRDN Wireless 802.1X',
  auth_method: '802.1X EAP-TLS',
  auth_result: 'ACCEPT',
  reason: 'Certificate valid, AD group Clinical',
  enforcement_profiles: 'Clinical staff',
  nas_ip: '10.42.3.12',
};

const ROW_REJECT = {
  auth_time: 1_753_000_000, // epoch seconds — the legacy key on purpose
  user: 'lab-laptop-7',
  calling_station_id: '482AE31107C4',
  service: 'MRDN Wired MAB',
  method: 'MAC-AUTH',
  result: 'Access-Reject',
  reject_reason: 'Password expired in Active Directory',
  nas_name: 'sw-acc-3f-3',
};

const ROW_TIMEOUT = {
  timestamp: '2026-07-25T09:35:08Z',
  username: 'guest-4471',
  mac: 'f0:18:98:5c:11:73',
  service: 'MRDN Guest Portal',
  auth_method: 'portal',
  status: 'no-response',
  nas: 'ap-1f-04',
};

/** A /api/session accounting row — the documented CPPM shape, no verdict field. */
const ROW_SESSION = {
  id: 90_112,
  acctsessionid: '5F2A-0001',
  acctstarttime: '2026-07-25T09:44:02Z',
  username: 'r.patel',
  mac_address: '9c:8e:99:1a:2b:3c',
  service_name: 'MRDN Wireless 802.1X',
  auth_type: 'EAP-TLS',
  nasipaddress: '10.42.3.19',
  enforcement_profile: 'Clinical staff',
};

/** 'HH:MM:SS' the way the adapter renders it (local wall-clock, design style). */
function expectedHhmmss(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
}

// -- Pure helpers ------------------------------------------------------------------

describe('pure helpers', () => {
  it('normalizeMac handles every separator and case', () => {
    expect(normalizeMac('3C-22-FB-41-0A-19')).toBe('3c:22:fb:41:0a:19');
    expect(normalizeMac('482AE31107C4')).toBe('48:2a:e3:11:07:c4');
    expect(normalizeMac('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('not-a-mac')).toBe('not-a-mac'); // not 12 hex digits — passthrough
  });

  it('authResultFor maps the vocabulary onto accept|reject|timeout', () => {
    expect(authResultFor('ACCEPT')).toEqual({ result: 'accept', tone: 'success', matched: true });
    expect(authResultFor('Access-Accept')).toEqual({ result: 'accept', tone: 'success', matched: true });
    expect(authResultFor('Access-Reject')).toEqual({ result: 'reject', tone: 'danger', matched: true });
    expect(authResultFor('DENIED')).toEqual({ result: 'reject', tone: 'danger', matched: true });
    expect(authResultFor('no-response')).toEqual({ result: 'timeout', tone: 'warning', matched: true });
  });

  // The bucket is a fallback, not CPPM's answer — the caller has to be able to
  // tell the two apart so the raw verdict can travel with the row.
  it('authResultFor reports an unrecognised verdict as unmatched', () => {
    expect(authResultFor('some-unrecognised-verdict')).toEqual({
      result: 'timeout',
      tone: 'warning',
      matched: false,
    });
    expect(authResultFor(null)).toEqual({ result: 'timeout', tone: 'warning', matched: false });
  });

  it('authMethodFor normalises to 802.1X / MAB / TACACS+', () => {
    expect(authMethodFor('802.1X EAP-TLS')).toBe('802.1X');
    expect(authMethodFor('dot1x')).toBe('802.1X');
    expect(authMethodFor('MAC-AUTH')).toBe('MAB');
    expect(authMethodFor('mab')).toBe('MAB');
    expect(authMethodFor('TACACS+ admin')).toBe('TACACS+');
    expect(authMethodFor('portal')).toBe('portal'); // unfamiliar — passed through
    expect(authMethodFor(null)).toBe('—');
  });
});

// -- Row mapping ---------------------------------------------------------------------

describe('mapClearPassAuthEvent', () => {
  it('maps a full Insight row', () => {
    const e = mapClearPassAuthEvent(ROW_ACCEPT);
    expect(e).not.toBeNull();
    expect(e!.time).toBe(expectedHhmmss(Date.parse(ROW_ACCEPT.timestamp)));
    expect(e!.who).toBe('m.okonjo');
    expect(e!.mac).toBe('3c:22:fb:41:0a:19');
    expect(e!.service).toBe('MRDN Wireless 802.1X');
    expect(e!.method).toBe('802.1X');
    expect(e!.result).toBe('accept');
    expect(e!.tone).toBe('success');
    expect(e!.reason).toBe('Certificate valid, AD group Clinical');
    expect(e!.role).toBe('role Clinical staff');
    expect(e!.nas).toBe('10.42.3.12');
    expect(e!.plane).toBe('CLEARPASS');
    expect(e!.tsMs).toBe(Date.parse(ROW_ACCEPT.timestamp));
  });

  it('maps a legacy reject row (epoch seconds, different keys)', () => {
    const e = mapClearPassAuthEvent(ROW_REJECT);
    expect(e).not.toBeNull();
    expect(e!.time).toBe(expectedHhmmss(1_753_000_000_000));
    expect(e!.who).toBe('lab-laptop-7');
    expect(e!.mac).toBe('48:2a:e3:11:07:c4');
    expect(e!.service).toBe('MRDN Wired MAB');
    expect(e!.method).toBe('MAB');
    expect(e!.result).toBe('reject');
    expect(e!.tone).toBe('danger');
    expect(e!.reason).toBe('Password expired in Active Directory');
    expect(e!.role).toBe('no role assigned');
    expect(e!.nas).toBe('sw-acc-3f-3');
    expect(e!.tsMs).toBe(1_753_000_000_000);
  });

  it('maps a no-response row to timeout/warning', () => {
    const e = mapClearPassAuthEvent(ROW_TIMEOUT);
    expect(e!.result).toBe('timeout');
    expect(e!.tone).toBe('warning');
    expect(e!.method).toBe('portal'); // unfamiliar method passes through
    expect(e!.reason).toBe('—');
  });

  it('tolerates a row with no timestamp: display —, no hint', () => {
    const e = mapClearPassAuthEvent({ username: 'ghost', result: 'ACCEPT' });
    expect(e).not.toBeNull();
    expect(e!.time).toBe('—');
    expect(e!.tsMs).toBeUndefined();
    expect(e!.mac).toBe('—');
  });

  it('returns null for rows with no identity at all', () => {
    expect(mapClearPassAuthEvent(null)).toBeNull();
    expect(mapClearPassAuthEvent({ service: 'MRDN Wireless 802.1X' })).toBeNull();
  });

  it('maps an /api/session accounting row — no verdict field means accept', () => {
    // A session exists only because RADIUS already answered Access-Accept;
    // bucketing it as 'timeout' would report a live network at 0% accept rate.
    const e = mapClearPassAuthEvent(ROW_SESSION);
    expect(e).not.toBeNull();
    expect(e!.time).toBe(expectedHhmmss(Date.parse(ROW_SESSION.acctstarttime)));
    expect(e!.tsMs).toBe(Date.parse(ROW_SESSION.acctstarttime));
    expect(e!.who).toBe('r.patel');
    expect(e!.mac).toBe('9c:8e:99:1a:2b:3c');
    expect(e!.method).toBe('802.1X'); // auth_type
    expect(e!.nas).toBe('10.42.3.19'); // nasipaddress
    expect(e!.role).toBe('role Clinical staff');
    expect(e!.result).toBe('accept');
    expect(e!.tone).toBe('success');
  });

  it('still buckets an explicit unknown verdict as timeout, session row or not', () => {
    const e = mapClearPassAuthEvent({ ...ROW_SESSION, auth_status: 'something-new' });
    expect(e!.result).toBe('timeout');
    expect(e!.tone).toBe('warning');
    // …and the raw verdict travels with the row: an operator must never read a
    // fabricated timeout with no evidence of what CPPM actually answered.
    expect(e!.reason).toBe('unmapped result: something-new');
  });

  it('keeps a reported reason alongside the unmapped raw verdict', () => {
    const e = mapClearPassAuthEvent({
      username: 'x.chen',
      mac: 'aa:bb:cc:00:11:22',
      auth_status: 'Access-Challenge',
      reason: 'EAP identity requested',
    });
    expect(e!.result).toBe('timeout');
    expect(e!.reason).toBe('EAP identity requested · unmapped result: Access-Challenge');
  });

  it('renders the design HH:MM:SS time, so a burst inside one minute stays orderable', () => {
    const first = mapClearPassAuthEvent({ ...ROW_ACCEPT, timestamp: '2026-07-25T09:41:22Z' });
    const second = mapClearPassAuthEvent({ ...ROW_ACCEPT, timestamp: '2026-07-25T09:41:47Z' });
    expect(first!.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(first!.time).not.toBe(second!.time);
  });
});

// -- Endpoint repository row mapping -----------------------------------------------------

/** A recorded CPPM 6.x /api/endpoint row (verbatim date strings on purpose). */
const ENDPOINT_ROW = {
  id: 3114,
  mac_address: '00:1B:C5:09:7F:22',
  description: 'Infusion pump, room 4A-12',
  status: 'Known',
  randomized_mac: false,
  device_insight_tags: ['Medical Device', 'IoT'],
  attributes: {
    'IP Address': '10.42.30.44',
    'Device Name': 'infusion-4a-12',
    Category: 'Computer',
    Family: 'Embedded',
    OS: 'RTOS 4.2',
    Profile: 'Medical device',
    'Updated At': 'Aug 06, 2025 09:12:44 CDT',
  },
  added_at: 'Jun 02, 2025 08:00:11 CDT',
  updated_at: 'Aug 06, 2025 11:32:01 CDT',
};

describe('mapClearPassEndpoint', () => {
  it('maps a recorded CPPM row — profiling facts out of attributes', () => {
    const e = mapClearPassEndpoint(ENDPOINT_ROW);
    expect(e).not.toBeNull();
    expect(e!.id).toBe('3114');
    expect(e!.mac).toBe('00:1b:c5:09:7f:22');
    expect(e!.description).toBe('Infusion pump, room 4A-12');
    expect(e!.ip).toBe('10.42.30.44');
    expect(e!.hostname).toBe('infusion-4a-12');
    expect(e!.status).toBe('Known');
    expect(e!.category).toBe('Computer');
    expect(e!.family).toBe('Embedded');
    expect(e!.os).toBe('RTOS 4.2');
    expect(e!.profile).toBe('Medical device');
    // the profiled stamp wins when attributes carry one…
    expect(e!.updatedAt).toBe('Aug 06, 2025 09:12:44 CDT');
    expect(e!.insightTags).toEqual(['Medical Device', 'IoT']);
  });

  it('falls back to the top-level updated_at verbatim — never null when the row carries it', () => {
    const noProfiled = { ...ENDPOINT_ROW, attributes: { Category: 'Computer' } };
    expect(mapClearPassEndpoint(noProfiled)!.updatedAt).toBe('Aug 06, 2025 11:32:01 CDT');
    const noAttrs = { ...ENDPOINT_ROW };
    delete (noAttrs as Record<string, unknown>).attributes;
    expect(mapClearPassEndpoint(noAttrs)!.updatedAt).toBe('Aug 06, 2025 11:32:01 CDT');
  });

  it('maps description, and leaves it null when the row does not carry one', () => {
    const bare = { ...ENDPOINT_ROW };
    delete (bare as Record<string, unknown>).description;
    expect(mapClearPassEndpoint(bare)!.description).toBeNull();
  });

  it('omits insightTags when the row carries none, and drops non-string tags', () => {
    const noTags = { ...ENDPOINT_ROW };
    delete (noTags as Record<string, unknown>).device_insight_tags;
    expect(mapClearPassEndpoint(noTags)!.insightTags).toBeUndefined();
    expect(mapClearPassEndpoint({ ...ENDPOINT_ROW, device_insight_tags: [] })!.insightTags).toBeUndefined();
    expect(
      mapClearPassEndpoint({ ...ENDPOINT_ROW, device_insight_tags: ['IoT', null, ' ', false, { x: 1 }] })!.insightTags,
    ).toEqual(['IoT']);
  });

  it('keeps device_insight_tags OUT of profile — the profiler evidence is not the enforcement answer', () => {
    const e = mapClearPassEndpoint({ ...ENDPOINT_ROW, attributes: {} });
    expect(e!.profile).toBeNull(); // no attributes.Profile, no top-level enforcement_profile
    expect(e!.insightTags).toEqual(['Medical Device', 'IoT']);
  });
});

// -- Policy-inventory row mapping ---------------------------------------------------------

describe('policy-inventory mappers', () => {
  it('mapClearPassNetworkDevice maps a NAD row, defensively', () => {
    const nad = mapClearPassNetworkDevice({
      id: 501,
      name: 'sw-core-a',
      ip_address: '10.42.8.11',
      vendor_name: 'Aruba',
      coa_capable: true,
      radsec_enabled: false,
      description: 'Campus-01 core',
    });
    expect(nad).toEqual({
      id: '501',
      name: 'sw-core-a',
      ipAddress: '10.42.8.11',
      vendorName: 'Aruba',
      coaCapable: true,
      radsecEnabled: false,
      description: 'Campus-01 core',
    });
    // partial row: absent facts are null, never assumed
    const partial = mapClearPassNetworkDevice({ name: 'sw-acc-3f-2', radsec_enabled: 'true' });
    expect(partial).toEqual({
      id: 'sw-acc-3f-2',
      name: 'sw-acc-3f-2',
      ipAddress: null,
      vendorName: null,
      coaCapable: null,
      radsecEnabled: true, // string form tolerated
      description: null,
    });
    // a NAD with no name is junk
    expect(mapClearPassNetworkDevice({ ip_address: '10.42.8.11' })).toBeNull();
    expect(mapClearPassNetworkDevice(null)).toBeNull();
    expect(mapClearPassNetworkDevice('sw-core-a')).toBeNull();
  });

  it('mapClearPassAuthSource maps name/type/description, null without a name', () => {
    expect(mapClearPassAuthSource({ id: 7, name: 'AD meridian.health', type: 'Active Directory', description: 'dc-01' })).toEqual({
      id: '7',
      name: 'AD meridian.health',
      type: 'Active Directory',
      description: 'dc-01',
    });
    expect(mapClearPassAuthSource({ name: 'Local User Repository' })).toEqual({
      id: 'Local User Repository',
      name: 'Local User Repository',
      type: null,
      description: null,
    });
    expect(mapClearPassAuthSource({ type: 'Local' })).toBeNull();
  });

  it('mapClearPassRole maps name/description, null without a name', () => {
    expect(mapClearPassRole({ id: 3, name: 'Clinical staff', description: 'vlan 820' })).toEqual({
      id: '3',
      name: 'Clinical staff',
      description: 'vlan 820',
    });
    expect(mapClearPassRole({ name: 'Quarantine' })).toEqual({ id: 'Quarantine', name: 'Quarantine', description: null });
    expect(mapClearPassRole({ description: 'no name' })).toBeNull();
  });

  it('mapClearPassEnforcementPolicy maps type + default profile', () => {
    expect(
      mapClearPassEnforcementPolicy({
        id: 9,
        name: 'MRDN Wireless 802.1X Enforcement',
        enforcement_type: 'RADIUS',
        default_profile: 'Quarantine',
      }),
    ).toEqual({
      id: '9',
      name: 'MRDN Wireless 802.1X Enforcement',
      enforcementType: 'RADIUS',
      defaultProfile: 'Quarantine',
    });
    expect(mapClearPassEnforcementPolicy({ name: 'Guest', default_enforcement_profile: 'Guest' })!.defaultProfile).toBe(
      'Guest',
    );
    expect(mapClearPassEnforcementPolicy({ enforcement_type: 'RADIUS' })).toBeNull();
  });

  it('mapClearPassEnforcementProfile maps name/type/description, null without a name', () => {
    expect(mapClearPassEnforcementProfile({ id: 2, name: 'Guest', type: 'RADIUS', description: 'vlan 812' })).toEqual({
      id: '2',
      name: 'Guest',
      type: 'RADIUS',
      description: 'vlan 812',
    });
    expect(mapClearPassEnforcementProfile({ name: 'Quarantine' })).toEqual({
      id: 'Quarantine',
      name: 'Quarantine',
      type: null,
      description: null,
    });
    expect(mapClearPassEnforcementProfile({ type: 'RADIUS' })).toBeNull();
  });

  it('mapClearPassLocalUser is a strict whitelist — no password material crosses', () => {
    const u = mapClearPassLocalUser({
      id: 21,
      user_id: 'portal-collector',
      username: 'Portal Collector Service',
      role_name: 'read-only shell',
      enabled: true,
      password: 's3cr3t-hash',
      password_hash: '$2y$10$abcdef',
      verify_password: 's3cr3t-hash',
      some_future_field: 'unexpected',
    });
    expect(u).toEqual({
      id: '21',
      userId: 'portal-collector',
      username: 'Portal Collector Service',
      roleName: 'read-only shell',
      enabled: true,
    });
    expect(Object.keys(u!)).toEqual(['id', 'userId', 'username', 'roleName', 'enabled']);
    expect(JSON.stringify(u)).not.toContain('s3cr3t');
    expect(JSON.stringify(u)).not.toContain('$2y$');
    // user_id is the identity — a row without it is junk
    expect(mapClearPassLocalUser({ username: 'ghost' })).toBeNull();
    expect(mapClearPassLocalUser({ user_id: 'svc', enabled: 'false' })).toEqual({
      id: 'svc',
      userId: 'svc',
      username: null,
      roleName: null,
      enabled: false,
    });
  });

  it('mapClearPassService maps name/type/description, null without a name', () => {
    expect(mapClearPassService({ id: 4, name: 'MRDN Wireless 802.1X', type: '1X', description: 'EAP-TLS' })).toEqual({
      id: '4',
      name: 'MRDN Wireless 802.1X',
      type: '1X',
      description: 'EAP-TLS',
    });
    expect(mapClearPassService({ name: 'Guest' })).toEqual({ id: 'Guest', name: 'Guest', type: null, description: null });
    expect(mapClearPassService({ type: '1X' })).toBeNull();
  });

  it('mapClearPassService maps the 6.11 /api/config/service shape', () => {
    // Verified against a live CPPM 6.11.12: /api/config/service/{id} answers
    // this object (fields not on the row contract — monitor_mode,
    // rules_match_type — are ignored, like every unknown field).
    expect(
      mapClearPassService({
        id: 1,
        name: 'Device Admin (TACACS+)',
        type: 'TACACS',
        template: 'TACACS+ Enforcement',
        enabled: false,
        hit_count: 0,
        order_no: 11,
        description: 'switch shell',
        monitor_mode: false,
        rules_match_type: 'MATCH_ALL',
        rules_conditions: [{ type: 'Connection', name: 'NAD-IP-Address', operator: 'EQUALS', value: '127.0.0.1' }],
        auth_sources: ['AD meridian.health', 'Local User Repository'],
      }),
    ).toEqual({
      id: '1',
      name: 'Device Admin (TACACS+)',
      type: 'TACACS',
      description: 'switch shell',
      template: 'TACACS+ Enforcement',
      enabled: false,
      hitCount: 0,
      orderNo: 11,
      authSources: ['AD meridian.health', 'Local User Repository'],
      rulesSummary: 'Connection:NAD-IP-Address EQUALS 127.0.0.1',
    });
  });

  it('mapClearPassService degrades present-but-unreadable fields to null, never the row', () => {
    expect(
      mapClearPassService({ name: 'S', enabled: 'perhaps', hit_count: 'lots', order_no: {}, rules_conditions: 'yes' }),
    ).toEqual({
      id: 'S',
      name: 'S',
      type: null,
      description: null,
      enabled: null,
      hitCount: null,
      orderNo: null,
      rulesSummary: null,
    });
    // auth_sources ride along only when the row names them readably
    expect(mapClearPassService({ name: 'S2', auth_sources: [{ name: 'AD meridian.health' }] })!.authSources).toEqual([
      'AD meridian.health',
    ]);
    expect(mapClearPassService({ name: 'S3', auth_sources: 'AD' })).not.toHaveProperty('authSources');
  });

  it('mapClearPassService lets no credential material cross — the row is a whitelist', () => {
    const s = mapClearPassService({
      id: 9,
      name: 'MRDN Wired MAB',
      type: 'MAC_AUTH',
      shared_secret: 's3cr3t',
      tacacs_secret: 'hunter2',
      some_future_field: 'unexpected',
    });
    expect(Object.keys(s!)).toEqual(['id', 'name', 'type', 'description']);
    expect(JSON.stringify(s)).not.toMatch(/s3cr3t|hunter2|unexpected/);
  });

  it('mapClearPassServiceDetail maps the verified 6.11 /api/config/service/{id} object, whole', () => {
    // Verified against a live CPPM 6.11.12 — every field of the detail shape,
    // plus the _links block and an unknown future field the whitelist drops.
    const detail = mapClearPassServiceDetail({
      id: 4,
      name: 'MRDN Guest 802.1X',
      type: 'RADIUS',
      template: '802.1X Wireless',
      enabled: true,
      hit_count: 412,
      order_no: 3,
      description: 'guest SSID · sponsor-approved accounts',
      monitor_mode: false,
      rules_match_type: 'MATCHES_ALL',
      rules_conditions: [
        { type: 'Radius', name: 'Called-Station-Id', operator: 'CONTAINS', value: 'MRDN-Guest' },
        { operator: 'BELONGS_TO', value: ['10.42.8.11', '10.42.8.32'] },
      ],
      auth_methods: [{ name: 'PEAP' }, 'MSCHAPv2'],
      auth_sources: [{ name: 'Local User Repository' }],
      strip_username: false,
      role_mapping_policy: 'MRDN Guest Role Mapping',
      enf_policy: 'MRDN Guest Portal Enforcement',
      use_cached_policy_results: true,
      posture_enabled: false,
      audit_enabled: false,
      profiler_enabled: true,
      acct_proxy_enabled: false,
      _links: { self: { href: '/api/config/service/4' } },
      some_future_field: 'unexpected',
    });
    expect(detail).toEqual({
      id: '4',
      name: 'MRDN Guest 802.1X',
      type: 'RADIUS',
      template: '802.1X Wireless',
      enabled: true,
      hitCount: 412,
      orderNo: 3,
      description: 'guest SSID · sponsor-approved accounts',
      monitorMode: false,
      rulesMatchType: 'MATCHES_ALL',
      rulesConditions: [
        { type: 'Radius', name: 'Called-Station-Id', operator: 'CONTAINS', value: 'MRDN-Guest' },
        // a partial condition keeps its readable fields; a list value joins
        { type: null, name: null, operator: 'BELONGS_TO', value: '10.42.8.11, 10.42.8.32' },
      ],
      authMethods: ['PEAP', 'MSCHAPv2'],
      authSources: ['Local User Repository'],
      stripUsername: false,
      roleMappingPolicy: 'MRDN Guest Role Mapping',
      enforcementPolicy: 'MRDN Guest Portal Enforcement',
      useCachedPolicyResults: true,
      postureEnabled: false,
      auditEnabled: false,
      profilerEnabled: true,
      acctProxyEnabled: false,
    });
    // the whitelist holds: nothing but the named fields crossed
    expect(JSON.stringify(detail)).not.toMatch(/unexpected|_links/);
  });

  it('mapClearPassServiceDetail keeps absent booleans null (absence is not false) and drops junk', () => {
    const detail = mapClearPassServiceDetail({ name: 'Bare' });
    expect(detail).toEqual({
      id: 'Bare',
      name: 'Bare',
      type: null,
      template: null,
      enabled: null, // absent — NOT false
      hitCount: null,
      orderNo: null,
      description: null,
      monitorMode: null,
      rulesMatchType: null,
      rulesConditions: [],
      authMethods: [],
      authSources: [],
      stripUsername: null,
      roleMappingPolicy: null,
      enforcementPolicy: null,
      useCachedPolicyResults: null,
      postureEnabled: null,
      auditEnabled: null,
      profilerEnabled: null,
      acctProxyEnabled: null,
    });
    // present-but-unreadable degrades the field, never the object; a
    // condition with nothing readable is dropped; string booleans read
    const mixed = mapClearPassServiceDetail({
      name: 'Mixed',
      enabled: 'false',
      rules_conditions: [{}, { type: 'Connection' }, 'junk'],
      auth_methods: 'PEAP',
      enf_policy: 42,
    });
    expect(mixed!.enabled).toBe(false);
    expect(mixed!.rulesConditions).toEqual([{ type: 'Connection', name: null, operator: null, value: null }]);
    expect(mixed!.authMethods).toEqual([]);
    expect(mixed!.enforcementPolicy).toBe('42'); // numeric policy ids read as their string
    // a service with no name is junk
    expect(mapClearPassServiceDetail({ type: 'RADIUS' })).toBeNull();
    expect(mapClearPassServiceDetail(null)).toBeNull();
  });

  it('mapClearPassServiceDetail lets no credential material cross — the same whitelist as the row', () => {
    const s = mapClearPassServiceDetail({
      id: 9,
      name: 'Device Admin (TACACS+)',
      type: 'TACACS',
      shared_secret: 's3cr3t',
      tacacs_secret: 'hunter2',
      password: 'p@ss',
    });
    expect(JSON.stringify(s)).not.toMatch(/s3cr3t|hunter2|p@ss/);
    expect(Object.keys(s!).sort()).toEqual([
      'acctProxyEnabled',
      'auditEnabled',
      'authMethods',
      'authSources',
      'description',
      'enabled',
      'enforcementPolicy',
      'hitCount',
      'id',
      'monitorMode',
      'name',
      'orderNo',
      'postureEnabled',
      'profilerEnabled',
      'roleMappingPolicy',
      'rulesConditions',
      'rulesMatchType',
      'stripUsername',
      'template',
      'type',
      'useCachedPolicyResults',
    ]);
  });

  it('summarizeServiceRules renders one readable line and degrades to null', () => {
    expect(
      summarizeServiceRules([{ type: 'Connection', name: 'NAD-IP-Address', operator: 'EQUALS', value: '127.0.0.1' }]),
    ).toBe('Connection:NAD-IP-Address EQUALS 127.0.0.1');
    // multiple conditions join ' · '; unreadable entries are skipped, a list
    // value reads as a list, and a condition may name only an operator/value
    expect(
      summarizeServiceRules([
        { type: 'Radius', name: 'Called-Station-Id', operator: 'CONTAINS', value: 'MRDN-Guest' },
        'junk',
        { operator: 'BELONGS_TO', value: ['10.42.8.11', '10.42.8.32'] },
      ]),
    ).toBe('Radius:Called-Station-Id CONTAINS MRDN-Guest · BELONGS_TO 10.42.8.11, 10.42.8.32');
    expect(summarizeServiceRules('not-an-array')).toBeNull();
    expect(summarizeServiceRules([])).toBeNull();
    expect(summarizeServiceRules([42, null])).toBeNull();
  });

  it('mapClearPassDeviceGroup maps name/description, null without a name', () => {
    expect(mapClearPassDeviceGroup({ id: 8, name: 'CX switches', description: 'Campus-01 access' })).toEqual({
      id: '8',
      name: 'CX switches',
      description: 'Campus-01 access',
    });
    expect(mapClearPassDeviceGroup({ name: 'APs' })).toEqual({ id: 'APs', name: 'APs', description: null });
    expect(mapClearPassDeviceGroup({ description: 'no name' })).toBeNull();
  });
});

// -- pull() with an in-memory fake fetch (no network) ---------------------------------

type HandlerResult = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (method: string, pathname: string, query: URLSearchParams, body: unknown) => HandlerResult | undefined;

interface FakeFetch {
  fn: FetchLike;
  calls: string[];
  authHeaders: (string | null)[];
  bodies: (string | null)[];
}

/**
 * The inventory resources a live CPPM answers 200 (verified against a real
 * 6.11.12 box with an OAuth client-credentials token) — an empty HAL page
 * here, unless the test's own handler routes the path. /api/config/service
 * answers 200 on 6.11 too, but it stays unrouted by default like /api/service
 * and /api/device-group (both 404 on that box's older siblings), so the
 * default fake models the pre-6.11 box where every service candidate 404s;
 * a test wanting different behaviour returns an explicit result for the path
 * from its handler.
 */
const INVENTORY_PATHS = new Set([
  '/api/network-device',
  '/api/auth-source',
  '/api/role',
  '/api/enforcement-policy',
  '/api/enforcement-profile',
  '/api/local-user',
]);

function fakeFetch(handler: Handler): FakeFetch {
  const calls: string[] = [];
  const authHeaders: (string | null)[] = [];
  const bodies: (string | null)[] = [];
  const fn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init?.method as string | undefined) ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    authHeaders.push(headers.authorization ?? null);
    const raw = typeof init?.body === 'string' ? init.body : null;
    bodies.push(raw);
    const result = handler(method, u.pathname, u.searchParams, raw === null ? undefined : JSON.parse(raw));
    if (!result && method === 'GET' && INVENTORY_PATHS.has(u.pathname)) {
      const empty = { count: 0, _links: { self: { href: u.pathname } }, _embedded: { items: [] } };
      return new Response(JSON.stringify(empty), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!result) {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    });
  };
  return { fn, calls, authHeaders, bodies };
}

function makeState(): PlaneState {
  return { id: 'clearpass', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

/** The legacy pre-minted-token credentials (still supported). */
const CREDS = { host: 'https://cppm.example.com', token: 'cppm-token-shh' };
/** What the connect drawer actually saves: publisher + API client credentials. */
const OAUTH_CREDS = {
  publisher: 'cppm-01.meridian.health',
  clientId: 'portal-insight',
  clientSecret: 'cppm-client-s3cr3t',
};

const AUTH_PATH = '/api/session';
const INSIGHT_PATH = '/api/insight/endpoint/auth-events';

function makeAdapter(handler: Handler, creds: Record<string, string> = CREDS) {
  const { fn, calls, authHeaders, bodies } = fakeFetch(handler);
  const recorded: { path: string; ms: number; code: string }[] = [];
  const state = makeState();
  // The backoff sleep is captured, never actually awaited in wall time — the
  // test asserts the delay the adapter CHOSE, without paying it.
  const slept: number[] = [];
  const adapter = new ClearPassAdapter(creds, state, (c) => recorded.push(c), fn, async (ms) => {
    slept.push(ms);
  });
  return { adapter, state, recorded, calls, authHeaders, bodies, slept };
}

/** The container a real CPPM answers a collection with. */
function hal(items: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { count: items.length, _links: { self: { href: AUTH_PATH } }, _embedded: { items }, ...extra };
}

const HAPPY_ROUTES: Record<string, unknown> = {
  // unordered on purpose, in the HAL envelope CPPM actually sends
  [`GET ${AUTH_PATH}`]: hal([ROW_REJECT, ROW_TIMEOUT, ROW_ACCEPT]),
};

function routeHandler(routes: Record<string, unknown>): Handler {
  return (method, pathname) => {
    const body = routes[`${method} ${pathname}`];
    return body === undefined ? undefined : { body };
  };
}

describe('ClearPassAdapter.pull()', () => {
  it('reads the HAL envelope, sorts newest first, and reports the summary note', async () => {
    const { adapter, state, recorded, authHeaders } = makeAdapter(routeHandler(HAPPY_ROUTES));
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(3);
    expect(pull.authEvents!.map((e) => e.who)).toEqual(['m.okonjo', 'guest-4471', 'lab-laptop-7']); // tsMs desc
    expect(state.note).toBe('3 auth events · 1 rejects');
    expect(state.health).toBe('healthy'); // promoted from 'warning' on first success
    // the static token rides the Authorization header on every call…
    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((h) => h === 'Bearer cppm-token-shh')).toBe(true);
    // …and never the recorded call log
    expect(JSON.stringify(recorded)).not.toContain('cppm-token-shh');
    expect(recorded.some((c) => c.path.startsWith(`GET ${AUTH_PATH}?`) && c.code === '200')).toBe(true);
  });

  it('asks for a bounded, sorted, paged window instead of the vendor default page', async () => {
    const { adapter, calls } = makeAdapter(routeHandler(HAPPY_ROUTES));
    await adapter.pull();
    const url = new URL(`https://cppm.example.com${calls.find((c) => c.startsWith(`GET ${AUTH_PATH}`))!.slice(4)}`);
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('sort')).toBe('-acctstarttime');
    const filter = JSON.parse(url.searchParams.get('filter') as string) as { acctstarttime: { $gte: string } };
    const since = Date.parse(filter.acctstarttime.$gte);
    expect(Date.now() - since).toBeGreaterThan(0);
    expect(Date.now() - since).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000); // a 24h window
  });

  it('pages until the newest-200 cap is filled', async () => {
    const base = Date.parse('2026-07-25T00:00:00Z');
    const many = Array.from({ length: MAX_AUTH_EVENTS + 5 }, (_, i) => ({
      timestamp: new Date(base + i * 60_000).toISOString(),
      username: `u${i}`,
      mac_address: i.toString(16).padStart(12, '0'),
      service: 'svc',
      auth_result: 'ACCEPT',
    }));
    const newestFirst = [...many].reverse(); // the server honours sort=-…, as CPPM does
    const { adapter, calls } = makeAdapter((method, pathname, query) => {
      if (method === 'GET' && pathname === '/api/endpoint') return { body: hal([]) };
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      const offset = Number(query.get('offset') ?? '0');
      const limit = Number(query.get('limit') ?? '25');
      return { body: hal(newestFirst.slice(offset, offset + limit), { count: newestFirst.length }) };
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(MAX_AUTH_EVENTS);
    expect(pull.authEvents![0].who).toBe(`u${MAX_AUTH_EVENTS + 4}`); // newest kept
    expect(pull.authEvents![MAX_AUTH_EVENTS - 1].who).toBe('u5'); // oldest five dropped
    // two pages of 100 — not one accidental page, and not an unbounded crawl
    const pages = calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain('offset=100');
    /* And the cap is declared. Five decisions in that window were never read,
       so '200 auth events · 0 rejects' describes the read and not the hour —
       the same statement uxi.ts and mist.ts make when a page cap stops a walk
       that still had rows behind it. */
    expect(pull.partial).toEqual(['authEvents']);
  });

  it('names the cap that stopped the walk in the plane note', async () => {
    const many = Array.from({ length: MAX_AUTH_EVENTS + 5 }, (_, i) => ({
      ...ROW_ACCEPT,
      username: `u${i}`,
    }));
    const { adapter, state } = makeAdapter((method, pathname, query) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      const offset = Number(query.get('offset') ?? '0');
      const limit = Number(query.get('limit') ?? '25');
      return { body: hal(many.slice(offset, offset + limit), { count: many.length }) };
    });
    await adapter.pull();
    expect(state.note).toContain(`window truncated (row cap ${MAX_AUTH_EVENTS})`);
  });

  it('stops paging when a short page says the window is exhausted', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...ROW_ACCEPT, username: `u${i}` }));
    const { adapter, calls, state } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/api/endpoint') return { body: hal([]) };
      return method === 'GET' && pathname === AUTH_PATH ? { body: hal(rows) } : undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(40);
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`))).toHaveLength(1);
    // A short page IS the end of the feed. Declaring that partial would put a
    // plane that read everything it was asked for into permanent warning.
    expect(pull.partial).toBeUndefined();
    expect(state.note).not.toContain('truncated');
  });

  /* The worst of the three, because nothing about it looks like a cap. A build
   * that rejects the paging query is served page one and asked no further, so
   * the walk does not stop early — it never starts. One page was being handed
   * to the screen as the whole window with nothing to say otherwise. */
  it('declares a build that can only ever serve page one', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ ...ROW_ACCEPT, username: `u${i}` }));
    const { adapter, state } = makeAdapter((method, pathname, query) => {
      if (method === 'GET' && pathname === '/api/endpoint') return { body: hal([]) };
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      if (query.has('filter')) return { status: 400, body: { detail: 'unknown parameter filter' } };
      return { body: hal(rows) };
    });
    const pull = await adapter.pull();
    expect(pull.partial).toEqual(['authEvents']);
    expect(state.note).toContain('window truncated (this build does not accept paging parameters)');
  });

  it('retries the first page bare when the build rejects the query vocabulary', async () => {
    // An older build 400s on the filter/sort params but still serves the resource.
    const { adapter, calls } = makeAdapter((method, pathname, query) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      if (query.has('filter')) return { status: 400, body: { detail: 'unknown parameter filter' } };
      return { body: hal([ROW_ACCEPT]) };
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(calls).toContain(`GET ${AUTH_PATH}`); // the bare retry
    // …and the bare style is remembered: the second pull does not re-probe with params
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}?`))).toHaveLength(1);
  });

  it('tolerates a 404 candidate and remembers the working path', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === INSIGHT_PATH ? { body: hal([ROW_ACCEPT]) } : undefined,
    );
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(calls.some((c) => c.startsWith(`GET ${AUTH_PATH}`))).toBe(true); // tried, 404

    await adapter.pull(); // resolved path goes first — the dead candidate is not retried
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith(`GET ${INSIGHT_PATH}`))).toHaveLength(2);
  });

  it('sends the Insight candidate an epoch start/end window', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === INSIGHT_PATH ? { body: hal([ROW_ACCEPT]) } : undefined,
    );
    await adapter.pull();
    const url = new URL(`https://cppm.example.com${calls.find((c) => c.startsWith(`GET ${INSIGHT_PATH}`))!.slice(4)}`);
    const start = Number(url.searchParams.get('start_time'));
    const end = Number(url.searchParams.get('end_time'));
    expect(end - start).toBeGreaterThanOrEqual(24 * 60 * 60); // seconds, not ms
    expect(end - start).toBeLessThanOrEqual(24 * 60 * 60 + 1); // ±1s from rounding the window edges
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('accepts a bare-array body (first array-valued key tolerance)', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: [ROW_ACCEPT, ROW_REJECT] };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(2);
  });

  it('prefers the logs payload key over an incidental array', async () => {
    // `{errors: [], logs: [...]}` — the first-array heuristic alone would zero the section.
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: { errors: [], logs: [ROW_ACCEPT] } };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(pull.authEvents![0].who).toBe('m.okonjo');
  });

  it('reads an empty HAL page as an honest empty feed (CPPM omits _embedded)', async () => {
    const { adapter, state } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: { count: 0, _links: { self: { href: AUTH_PATH } } } };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toEqual([]);
    expect(state.note).toBe('0 auth events · 0 rejects');
  });

  it('fails the pull on a 200 whose payload has no row container — never a silent empty feed', async () => {
    const { adapter, state } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: { status: 'ok', detail: { note: 'nothing here' } } };
      return undefined;
    });
    await expect(adapter.pull()).rejects.toThrow(/section 'authEvents' failed — 200 from \/api\/session/);
    await expect(adapter.pull()).rejects.toThrow(/no row container/);
    expect(state.health).toBe('warning'); // never promoted on an unreadable body
    expect(state.note).toBeNull();
  });

  it('fails the pull naming the section when every candidate 404s', async () => {
    const { adapter } = makeAdapter(() => undefined);
    await expect(adapter.pull()).rejects.toThrow(/section 'authEvents' failed/);
    await expect(adapter.pull()).rejects.toThrow(/404 on every candidate/);
  });

  // A build that names the timestamp field something we do not read still
  // reports real decisions — sinking them to the back of the 200-row cap threw
  // them away silently. They keep arrival order behind the dated rows instead.
  it('keeps undated rows rather than sorting them off the end of the cap, and names them', async () => {
    const dated = Array.from({ length: MAX_AUTH_EVENTS - 1 }, (_, i) => ({
      timestamp: new Date(Date.parse('2026-07-25T00:00:00Z') + i * 60_000).toISOString(),
      username: `dated-${i}`,
      auth_result: 'ACCEPT',
    }));
    const undated = [
      { occurred: '2026-07-25T09:00:00Z', username: 'undated-1', auth_result: 'ACCEPT' },
      { occurred: '2026-07-25T09:01:00Z', username: 'undated-2', auth_result: 'ACCEPT' },
    ];
    const { adapter, state } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === AUTH_PATH ? { body: hal([...undated, ...dated]) } : undefined,
    );
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(MAX_AUTH_EVENTS);
    // dated rows first (newest first), then the undated ones in arrival order
    expect(pull.authEvents![0].who).toBe(`dated-${MAX_AUTH_EVENTS - 2}`);
    expect(pull.authEvents![MAX_AUTH_EVENTS - 1].who).toBe('undated-1');
    expect(state.note).toContain('1 without timestamps');
  });

  // A throttle is not a verdict: back off (honouring Retry-After) and try
  // again rather than degrading the plane every 60s.
  it('backs off and retries a 429, honouring Retry-After', async () => {
    let throttled = 0;
    const { adapter, state, slept, calls } = makeAdapter((method, pathname) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      throttled += 1;
      if (throttled === 1) return { status: 429, body: { detail: 'rate limit' }, headers: { 'retry-after': '2' } };
      return { body: hal([ROW_ACCEPT]) };
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(slept).toEqual([2_000]); // Retry-After wins over the exponential floor
    expect(state.health).toBe('healthy'); // not degraded by a survivable throttle
    // every attempt is on the wire, so the Activity tab shows the real 429
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`))).toHaveLength(2);
  });

  it('names rate limiting when the throttle outlives the backoff', async () => {
    const { adapter, slept } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === AUTH_PATH ? { status: 429, body: {} } : undefined,
    );
    await expect(adapter.pull()).rejects.toThrow(/rate limited, backoff exhausted/);
    expect(slept).toEqual([1_000, 2_000]); // exponential floor, no Retry-After sent
  });

  it('rides out a transient 503 gateway blip', async () => {
    let n = 0;
    const { adapter } = makeAdapter((method, pathname) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      n += 1;
      return n === 1 ? { status: 503, body: {} } : { body: hal([ROW_ACCEPT]) };
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
  });

  // ClearPass describes policy, not a transport: no shell, no brokered push.
  // The reviewed direct writes (endpoint/local-user) are the one write claim.
  it('claims no shell, no brokered write and no config read', () => {
    const { adapter } = makeAdapter(routeHandler(HAPPY_ROUTES));
    expect(adapter.capabilities()).toEqual({ localShell: false, brokeredWrite: false, configRead: false, directWrite: true });
  });

  it('fails the pull naming the section on a non-404 error (a static token cannot self-heal on 401)', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) {
        return { status: 401, body: { error: 'bad token' } };
      }
      return undefined;
    });
    await expect(adapter.pull()).rejects.toThrow(/section 'authEvents' failed — HTTP 401/);
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`))).toHaveLength(1); // no retry
  });
});

// -- OAuth token minting (the credentials the product actually saves) ------------------

describe('ClearPassAdapter OAuth', () => {
  /** Mints numbered tokens so an invalidate + re-mint is visible. */
  function oauthHandler(rest: Handler): { handler: Handler; minted: () => number } {
    let n = 0;
    const handler: Handler = (method, pathname, query, body) => {
      if (method === 'POST' && pathname === '/api/oauth') {
        expect(body).toMatchObject({ grant_type: 'client_credentials', client_id: 'portal-insight' });
        n += 1;
        return { body: { access_token: `minted-${n}`, expires_in: 28_800, token_type: 'Bearer' } };
      }
      return rest(method, pathname, query, body);
    };
    return { handler, minted: () => n };
  }

  it('mints a token at POST /api/oauth and bears it on the auth-log call', async () => {
    const { handler, minted } = oauthHandler((method, pathname) =>
      method === 'GET' && pathname === AUTH_PATH ? { body: hal([ROW_ACCEPT]) } : undefined,
    );
    const { adapter, calls, authHeaders, recorded } = makeAdapter(handler, OAUTH_CREDS);
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(calls[0]).toBe('POST /api/oauth');
    expect(minted()).toBe(1);
    expect(authHeaders.filter((h) => h !== null)).toContain('Bearer minted-1');
    // one mint is shared by the whole poll — not one per call
    await adapter.pull();
    expect(minted()).toBe(1);
    // the client secret never reaches the call log
    expect(JSON.stringify(recorded)).not.toContain('cppm-client-s3cr3t');
    expect(recorded.some((c) => c.path === 'POST /api/oauth')).toBe(true);
  });

  it('invalidates and re-mints exactly once on a 401 (CPPM tokens expire at 8h)', async () => {
    let seenAuthCalls = 0;
    const { handler, minted } = oauthHandler((method, pathname) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      seenAuthCalls += 1;
      // the first call carries the (expired) first token
      if (seenAuthCalls === 1) return { status: 401, body: { detail: 'token expired' } };
      return { body: hal([ROW_ACCEPT]) };
    });
    const { adapter, authHeaders } = makeAdapter(handler, OAUTH_CREDS);
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(minted()).toBe(2); // mint, 401, re-mint
    expect(authHeaders).toContain('Bearer minted-2');
  });

  it('fails the pull naming /api/oauth when the mint itself fails', async () => {
    const { adapter } = makeAdapter(
      (method, pathname) => (method === 'POST' && pathname === '/api/oauth' ? { status: 403, body: {} } : undefined),
      OAUTH_CREDS,
    );
    await expect(adapter.pull()).rejects.toThrow(/\/api\/oauth answered HTTP 403 without an access_token/);
  });

  it('publishes the minted credential expiry on plane state (never the token)', async () => {
    // The registry seeds PlaneState.token with the SOURCE only; the 8-hour
    // CPPM grant's expiry is knowable here and nowhere else.
    const { handler } = oauthHandler((method, pathname) =>
      method === 'GET' && pathname === AUTH_PATH ? { body: hal([ROW_ACCEPT]) } : undefined,
    );
    const { adapter, state } = makeAdapter(handler, OAUTH_CREDS);
    const before = Date.now();
    await adapter.pull();
    expect(state.token?.source).toBe('oauth client_credentials');
    expect(Date.parse(state.token!.expiresAt!)).toBeGreaterThanOrEqual(before + 28_800 * 1000);
    expect(JSON.stringify(state.token)).not.toContain('minted-1');
    expect(JSON.stringify(state.token)).not.toContain('cppm-client-s3cr3t');
  });

  it('a mint without expires_in publishes no expiry rather than the 8h default', async () => {
    const handler: Handler = (method, pathname) => {
      if (method === 'POST' && pathname === '/api/oauth') return { body: { access_token: 'no-ttl' } };
      if (method === 'GET' && pathname === AUTH_PATH) return { body: hal([ROW_ACCEPT]) };
      return undefined;
    };
    const { adapter, state } = makeAdapter(handler, OAUTH_CREDS);
    await adapter.pull();
    expect(state.token).toEqual({ expiresAt: null, source: 'oauth client_credentials' });
  });

  it('accepts the credential record the connect drawer writes', () => {
    expect(ClearPassAdapter.isComplete({ ...OAUTH_CREDS, displayName: 'ClearPass', scopes: 'read:session' })).toBe(true);
    expect(ClearPassAdapter.isComplete(CREDS)).toBe(true); // legacy host + token
    expect(ClearPassAdapter.isComplete({ token: 'shh' })).toBe(false); // no publisher/host
    expect(ClearPassAdapter.isComplete({ publisher: 'cppm-01' })).toBe(false); // no credentials
    expect(ClearPassAdapter.isComplete({ publisher: 'cppm-01', clientId: 'x' })).toBe(false); // no secret
    expect(ClearPassAdapter.isComplete(null)).toBe(false);
  });
});

// -- The endpoint repository (the plane's second dataset) ------------------------------

describe('ClearPassAdapter endpoints', () => {
  const endpointRoutes: Handler = (method, pathname) => {
    if (method === 'GET' && pathname === AUTH_PATH) return { body: hal([ROW_ACCEPT]) };
    if (method === 'GET' && pathname === '/api/endpoint') {
      return { body: hal([{ id: 1, mac_address: 'aabbccddeeff' }], { count: 4182 }) };
    }
    return undefined;
  };

  it('reports the endpoint total as the plane device count and in the note', async () => {
    const { adapter, state, calls } = makeAdapter(endpointRoutes);
    await adapter.pull();
    expect(state.deviceCount).toBe(4182);
    expect(state.note).toBe('4,182 endpoints · 1 auth events · 0 rejects');
    expect(calls.some((c) => c.startsWith('GET /api/endpoint?'))).toBe(true);
    // one call for the count refresh, one for the detail-row walk
    expect(calls.filter((c) => c.startsWith('GET /api/endpoint'))).toHaveLength(2);

    // the repository is a 5-minute pull, not a 60-second one — for both halves
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith('GET /api/endpoint'))).toHaveLength(2);
  });

  it('drops the endpoint fact without failing the auth feed when /api/endpoint errors', async () => {
    const { adapter, state } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: hal([ROW_ACCEPT]) };
      if (method === 'GET' && pathname === '/api/endpoint') return { status: 500, body: { detail: 'boom' } };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(state.deviceCount).toBeNull();
    expect(state.note).toBe('1 auth events · 0 rejects');
  });

  it('reads one requested endpoint page, maps only the public row, and derives an exact next page from CPPM total', async () => {
    const { adapter, calls, recorded } = makeAdapter((method, pathname, query) => {
      if (method === 'GET' && pathname === '/api/endpoint') {
        expect(query.toString()).toBe('offset=50&limit=25&calculate_count=true');
        return {
          body: hal(
            [
              {
                id: 'ep-51',
                mac_address: 'AABB.CCDD.EE51',
                attributes: { 'Device Name': 'ward-tablet', Category: 'Computer' },
                client_secret: 'must-never-leave-the-adapter',
              },
            ],
            { count: 101 },
          ),
        };
      }
      return undefined;
    });

    const page = await adapter.endpointPage(50, 25);

    expect(page).toEqual({
      kind: 'ok',
      endpoints: [
        {
          id: 'ep-51',
          mac: 'aa:bb:cc:dd:ee:51',
          description: null,
          ip: null,
          hostname: 'ward-tablet',
          status: 'Unknown',
          category: 'Computer',
          family: null,
          os: null,
          profile: null,
          updatedAt: null,
        },
      ],
      total: 101,
      nextOffset: 51,
      more: 'yes',
    });
    expect(calls).toEqual(['GET /api/endpoint?offset=50&limit=25&calculate_count=true']);
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('must-never-leave-the-adapter');
  });

  it('keeps a full page with no proven total unknown instead of inventing a next page', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/api/endpoint') {
        return { body: hal(Array.from({ length: 2 }, (_, i) => ({ id: i + 1, mac_address: `aabbccdde${i}f` })), { count: 2 }) };
      }
      return undefined;
    });

    const page = await adapter.endpointPage(0, 2);

    expect(page).toMatchObject({ kind: 'ok', total: null, nextOffset: null, more: 'unknown' });
  });

  it('keeps an empty page and a broken read distinct', async () => {
    const empty = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === '/api/endpoint' ? { body: hal([]) } : undefined,
    );
    const failed = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === '/api/endpoint' ? { status: 500, body: { password: 'vendor-error-must-not-leak' } } : undefined,
    );

    await expect(empty.adapter.endpointPage(0, 50)).resolves.toMatchObject({
      kind: 'empty',
      endpoints: [],
      total: 0,
      nextOffset: null,
      more: 'no',
    });
    await expect(failed.adapter.endpointPage(0, 50)).resolves.toMatchObject({
      kind: 'failed',
      endpoints: [],
      total: null,
      nextOffset: null,
      more: 'unknown',
    });
  });
});

// -- The policy inventories (the plane's remaining datasets) ----------------------------

describe('ClearPassAdapter policy inventories', () => {
  const NAD = {
    id: 501,
    name: 'sw-core-a',
    ip_address: '10.42.8.11',
    vendor_name: 'Aruba',
    coa_capable: true,
    radsec_enabled: false,
    description: 'Campus-01 core',
  };
  const AUTH_SOURCE = { id: 7, name: 'AD meridian.health', type: 'Active Directory', description: 'dc-01' };
  const ROLE = { id: 3, name: 'Clinical staff', description: 'vlan 820' };
  const POLICY = { id: 9, name: 'MRDN Wireless 802.1X Enforcement', enforcement_type: 'RADIUS', default_profile: 'Quarantine' };
  const PROFILE = { id: 2, name: 'Guest', type: 'RADIUS', description: 'vlan 812' };
  const LOCAL_USER = {
    id: 21,
    user_id: 'portal-collector',
    username: 'Portal Collector Service',
    role_name: 'read-only shell',
    enabled: true,
    password: 's3cr3t-hash', // the wire carries it; the row must never
  };
  // The 6.11 shape, as /api/config/service/{id} answers it (verified live).
  const SERVICE = {
    id: 4,
    name: 'MRDN Wireless 802.1X',
    type: '1X',
    template: '802.1X Wireless',
    enabled: true,
    hit_count: 8910,
    order_no: 1,
    auth_sources: ['AD meridian.health'],
    rules_conditions: [{ type: 'Radius', name: 'Called-Station-Id', operator: 'CONTAINS', value: 'MRDN' }],
  };
  const GROUP = { id: 8, name: 'CX switches', description: 'Campus-01 access' };

  /** The full inventory surface, one row per resource. */
  const FULL_INVENTORY_ROUTES: Record<string, unknown> = {
    'GET /api/network-device': hal([NAD]),
    'GET /api/auth-source': hal([AUTH_SOURCE]),
    'GET /api/role': hal([ROLE]),
    'GET /api/enforcement-policy': hal([POLICY]),
    'GET /api/enforcement-profile': hal([PROFILE]),
    'GET /api/local-user': hal([LOCAL_USER]),
    'GET /api/config/service': hal([SERVICE]), // 6.11+: the config namespace answers
    'GET /api/device-group': hal([GROUP]),
  };

  /** Auth feed + endpoint repo + full inventory; `overrides` wins over the inventory routes. */
  function inventoryHandler(overrides: Handler): Handler {
    const inventory = routeHandler(FULL_INVENTORY_ROUTES);
    return (method, pathname, query, body) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: hal([ROW_ACCEPT]) };
      if (method === 'GET' && pathname === '/api/endpoint') return { body: hal([]) };
      return overrides(method, pathname, query, body) ?? inventory(method, pathname, query, body);
    };
  }

  it('ships every inventory dataset the box serves, mapped, with no partial', async () => {
    const { adapter, calls } = makeAdapter(inventoryHandler(() => undefined));
    const pull = await adapter.pull();
    expect(pull.networkDevices).toEqual([
      {
        id: '501',
        name: 'sw-core-a',
        ipAddress: '10.42.8.11',
        vendorName: 'Aruba',
        coaCapable: true,
        radsecEnabled: false,
        description: 'Campus-01 core',
      },
    ]);
    expect(pull.authSources).toEqual([
      { id: '7', name: 'AD meridian.health', type: 'Active Directory', description: 'dc-01' },
    ]);
    expect(pull.roles).toEqual([{ id: '3', name: 'Clinical staff', description: 'vlan 820' }]);
    expect(pull.enforcementPolicies).toEqual([
      { id: '9', name: 'MRDN Wireless 802.1X Enforcement', enforcementType: 'RADIUS', defaultProfile: 'Quarantine' },
    ]);
    expect(pull.enforcementProfiles).toEqual([{ id: '2', name: 'Guest', type: 'RADIUS', description: 'vlan 812' }]);
    expect(pull.localUsers).toHaveLength(1);
    expect(pull.services).toEqual([
      {
        id: '4',
        name: 'MRDN Wireless 802.1X',
        type: '1X',
        description: null,
        template: '802.1X Wireless',
        enabled: true,
        hitCount: 8910,
        orderNo: 1,
        authSources: ['AD meridian.health'],
        rulesSummary: 'Radius:Called-Station-Id CONTAINS MRDN',
      },
    ]);
    expect(pull.deviceGroups).toEqual([{ id: '8', name: 'CX switches', description: 'Campus-01 access' }]);
    expect(pull.partial).toBeUndefined();
    // the config namespace answered, so the legacy path was never probed
    expect(calls.filter((c) => c.startsWith('GET /api/config/service?'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('GET /api/service?'))).toHaveLength(0);
  });

  it('never lets local-user secret material into a pull — the whitelist holds on the wire too', async () => {
    const { adapter } = makeAdapter(inventoryHandler(() => undefined));
    const pull = await adapter.pull();
    expect(Object.keys(pull.localUsers![0])).toEqual(['id', 'userId', 'username', 'roleName', 'enabled']);
    expect(JSON.stringify(pull.localUsers)).not.toContain('s3cr3t');
  });

  // Verified against a live CPPM 6.11.12: /api/config/service is served
  // there while /api/service and /api/device-group 404; on older 6.x builds
  // BOTH service paths 404. Only a 404 on every candidate is "not available
  // on this CPPM" — the keys go absent with NO partial flag, or every lab
  // box would sit at warning.
  it('treats a 404 on every services/deviceGroups candidate as honest absence, not a partial read', async () => {
    const { adapter, calls } = makeAdapter(
      inventoryHandler((method, pathname) =>
        method === 'GET' &&
        (pathname === '/api/config/service' || pathname === '/api/service' || pathname === '/api/device-group')
          ? { status: 404, body: { detail: 'not found' } }
          : undefined,
      ),
    );
    const pull = await adapter.pull();
    expect(pull.services).toBeUndefined();
    expect(pull.deviceGroups).toBeUndefined();
    expect(pull.partial).toBeUndefined();
    expect(pull.roles).toHaveLength(1); // the rest of the plane still ships
    // the config namespace was tried first, the legacy path as the fallback
    const probes = calls.filter((c) => c.startsWith('GET /api/config/service?') || c.startsWith('GET /api/service?'));
    expect(probes.map((c) => c.split('?')[0])).toEqual(['GET /api/config/service', 'GET /api/service']);
    // …and the absence is cached for the cadence window, not re-probed per poll
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith('GET /api/config/service?'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('GET /api/service?'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('GET /api/device-group?'))).toHaveLength(1);
  });

  it('falls back to /api/service when the config namespace 404s (a pre-6.11 build)', async () => {
    const { adapter, calls } = makeAdapter(
      inventoryHandler((method, pathname) => {
        if (method === 'GET' && pathname === '/api/config/service') return { status: 404, body: {} };
        if (method === 'GET' && pathname === '/api/service') {
          return { body: hal([{ id: 4, name: 'MRDN Wireless 802.1X', type: '1X' }]) };
        }
        return undefined;
      }),
    );
    const pull = await adapter.pull();
    // the older shape still maps to exactly the older row
    expect(pull.services).toEqual([{ id: '4', name: 'MRDN Wireless 802.1X', type: '1X', description: null }]);
    expect(pull.partial).toBeUndefined();
    const probes = calls.filter((c) => c.startsWith('GET /api/config/service?') || c.startsWith('GET /api/service?'));
    expect(probes.map((c) => c.split('?')[0])).toEqual(['GET /api/config/service', 'GET /api/service']);
  });

  it('keeps the partial-failure rule on a non-404 services error — no fallback, the key is named', async () => {
    const { adapter, calls } = makeAdapter(
      inventoryHandler((method, pathname) =>
        method === 'GET' && pathname === '/api/config/service' ? { status: 500, body: {} } : undefined,
      ),
    );
    const pull = await adapter.pull();
    expect(pull.services).toBeUndefined();
    expect(pull.partial).toEqual(['services']);
    // a 500 is a broken read, not absence — the legacy path is never probed
    expect(calls.filter((c) => c.startsWith('GET /api/service?'))).toHaveLength(0);
  });

  it('never lets credential material ride a service row off the wire either', async () => {
    const { adapter } = makeAdapter(
      inventoryHandler((method, pathname) =>
        method === 'GET' && pathname === '/api/config/service'
          ? { body: hal([{ id: 4, name: 'MRDN Wired MAB', type: 'MAC_AUTH', shared_secret: 's3cr3t', tacacs_secret: 'hunter2' }]) }
          : undefined,
      ),
    );
    const pull = await adapter.pull();
    expect(Object.keys(pull.services![0])).toEqual(['id', 'name', 'type', 'description']);
    expect(JSON.stringify(pull.services)).not.toMatch(/s3cr3t|hunter2|secret/i);
  });

  it('names a failed inventory dataset in partial and never sinks the pull', async () => {
    const { adapter } = makeAdapter(
      inventoryHandler((method, pathname) =>
        method === 'GET' && pathname === '/api/role' ? { status: 500, body: { detail: 'boom' } } : undefined,
      ),
    );
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1); // the auth feed is untouched
    expect(pull.roles).toBeUndefined(); // the failed key is omitted…
    expect(pull.partial).toEqual(['roles']); // …and named
    expect(pull.networkDevices).toHaveLength(1); // its neighbours are unaffected
  });

  it('treats a 404 on a resource CPPM DOES serve as a broken read, not absence', async () => {
    const { adapter } = makeAdapter(
      inventoryHandler((method, pathname) =>
        method === 'GET' && pathname === '/api/auth-source' ? { status: 404, body: {} } : undefined,
      ),
    );
    const pull = await adapter.pull();
    expect(pull.authSources).toBeUndefined();
    expect(pull.partial).toEqual(['authSources']);
  });

  it('names every failed dataset, in dataset order', async () => {
    const { adapter } = makeAdapter(
      inventoryHandler((method, pathname) => {
        if (method === 'GET' && pathname === '/api/role') return { status: 500, body: {} };
        if (method === 'GET' && pathname === '/api/enforcement-profile') return { status: 404, body: {} };
        return undefined;
      }),
    );
    const pull = await adapter.pull();
    expect(pull.partial).toEqual(['roles', 'enforcementProfiles']);
  });

  it('reads empty inventory collections as real answers — and unrouted ones as the lab box does', async () => {
    // No inventory routes at all: the fake answers the six served resources
    // with empty HAL pages (a real CPPM 6.x) and 404s every service
    // candidate plus device-group, like the pre-6.11 box does.
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: hal([ROW_ACCEPT]) };
      if (method === 'GET' && pathname === '/api/endpoint') return { body: hal([]) };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.networkDevices).toEqual([]);
    expect(pull.authSources).toEqual([]);
    expect(pull.roles).toEqual([]);
    expect(pull.localUsers).toEqual([]);
    expect(pull.services).toBeUndefined();
    expect(pull.deviceGroups).toBeUndefined();
    expect(pull.partial).toBeUndefined(); // empty ≠ partial; absent ≠ partial
  });

  it('rides the endpoint repository 5-minute cadence, not the 60s poll', async () => {
    const { adapter, calls } = makeAdapter(inventoryHandler(() => undefined));
    await adapter.pull();
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith('GET /api/role?'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('GET /api/network-device?'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('GET /api/local-user?'))).toHaveLength(1);
  });
});

// -- On-demand service detail (the drawer's read, never the poller's) ------------------

describe('ClearPassAdapter.serviceDetail()', () => {
  /** The verified 6.11.12 detail object (a trimmed copy — the mapper tests
   *  above hold the whole shape). */
  const SERVICE_DETAIL = {
    id: 4,
    name: 'MRDN Guest 802.1X',
    type: 'RADIUS',
    template: '802.1X Wireless',
    enabled: true,
    hit_count: 412,
    order_no: 3,
    description: 'guest SSID · sponsor-approved accounts',
    monitor_mode: false,
    rules_match_type: 'MATCHES_ALL',
    rules_conditions: [{ type: 'Radius', name: 'Called-Station-Id', operator: 'CONTAINS', value: 'MRDN-Guest' }],
    auth_methods: ['PEAP', 'MSCHAPv2'],
    auth_sources: ['Local User Repository'],
    strip_username: false,
    role_mapping_policy: 'MRDN Guest Role Mapping',
    enf_policy: 'MRDN Guest Portal Enforcement',
    use_cached_policy_results: true,
    posture_enabled: false,
    audit_enabled: false,
    profiler_enabled: true,
    acct_proxy_enabled: false,
    _links: { self: { href: '/api/config/service/4' } },
  };

  it('reads and maps ONE service from the config namespace, sections ok', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === '/api/config/service/4' ? { body: SERVICE_DETAIL } : undefined,
    );
    const detail = await adapter.serviceDetail('4');
    expect(detail).not.toBeNull();
    expect(detail!.source.plane).toBe('clearpass');
    expect(detail!.source.sections).toEqual({ service: 'ok' });
    expect(detail!.service).toMatchObject({
      id: '4',
      name: 'MRDN Guest 802.1X',
      type: 'RADIUS',
      rulesMatchType: 'MATCHES_ALL',
      rulesConditions: [{ type: 'Radius', name: 'Called-Station-Id', operator: 'CONTAINS', value: 'MRDN-Guest' }],
      authMethods: ['PEAP', 'MSCHAPv2'],
      enforcementPolicy: 'MRDN Guest Portal Enforcement',
      profilerEnabled: true,
      postureEnabled: false,
    });
    // the whitelist held end to end — no credential-shaped key crossed
    expect(JSON.stringify(detail)).not.toMatch(/password|secret|hash/i);
    // one call, to the 6.11 path — the legacy path is never probed on a 200
    expect(calls).toEqual(['GET /api/config/service/4']);
  });

  it('a 404 on every candidate is an honest empty, never a failure', async () => {
    const { adapter, calls } = makeAdapter(() => undefined); // every path 404s
    const detail = await adapter.serviceDetail('no-such-service');
    expect(detail!.service).toBeNull();
    expect(detail!.source.sections).toEqual({ service: 'empty' });
    expect(detail!.source.note).toContain('404');
    // both candidates were tried, in the collection walk's order
    expect(calls).toEqual(['GET /api/config/service/no-such-service', 'GET /api/service/no-such-service']);
  });

  it('falls back to the legacy path when the config namespace 404s', async () => {
    const { adapter } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === '/api/service/7' ? { body: { id: 7, name: 'Legacy MAB', type: 'RADIUS' } } : undefined,
    );
    const detail = await adapter.serviceDetail('7');
    expect(detail!.source.sections).toEqual({ service: 'ok' });
    expect(detail!.service).toMatchObject({ id: '7', name: 'Legacy MAB', enabled: null });
  });

  it('a non-404 failure is a failed section with the status, and does NOT fall through', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === '/api/config/service/4' ? { status: 500 } : undefined,
    );
    const detail = await adapter.serviceDetail('4');
    expect(detail!.service).toBeNull();
    expect(detail!.source.sections).toEqual({ service: 'failed' });
    expect(detail!.source.note).toBe('HTTP 500');
    // a 500 is a broken read, not absence — the legacy path is not probed
    expect(calls).toEqual(['GET /api/config/service/4']);
  });

  it('a 200 with no service object in it is a broken read, not an absent service', async () => {
    const { adapter } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === '/api/config/service/4' ? { body: { count: 0 } } : undefined,
    );
    const detail = await adapter.serviceDetail('4');
    expect(detail!.source.sections).toEqual({ service: 'failed' });
    expect(detail!.source.note).toContain('no service object');
  });

  it('a transport error never throws — the section fails with the cause', async () => {
    const failing: FetchLike = async () => {
      throw new Error('socket hang up');
    };
    const adapter = new ClearPassAdapter(CREDS, makeState(), () => {}, failing);
    const detail = await adapter.serviceDetail('4');
    expect(detail!.source.sections).toEqual({ service: 'failed' });
    expect(detail!.source.note).toBe('socket hang up');
  });

  it('serves a reopen from the TTL cache and stamps it cached', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === '/api/config/service/4' ? { body: SERVICE_DETAIL } : undefined,
    );
    const first = await adapter.serviceDetail('4');
    expect(first!.source.cached).toBeFalsy();
    const second = await adapter.serviceDetail('4');
    expect(second!.source.cached).toBe(true);
    // …and a FAILING read is cached too, so a broken CPPM is not hammered
    expect(calls).toEqual(['GET /api/config/service/4']);
    const { adapter: broken, calls: brokenCalls } = makeAdapter(() => ({ status: 500 }));
    await broken.serviceDetail('9');
    await broken.serviceDetail('9');
    expect(brokenCalls).toEqual(['GET /api/config/service/9']);
  });

  it('an empty id is the cannot-answer null, and costs no call', async () => {
    const { adapter, calls } = makeAdapter(() => undefined);
    expect(await adapter.serviceDetail('   ')).toBeNull();
    expect(calls).toEqual([]);
  });
});

// -- The one sanctioned write ----------------------------------------------------------

describe('ClearPassAdapter.coaDisconnect()', () => {
  it('sends the vendor-required body and no enforcement profile by default', async () => {
    const { adapter, calls, bodies } = makeAdapter(() => ({ status: 200, body: {} }));
    const res = await adapter.coaDisconnect('3C-22-FB-41-0A-19');
    expect(res.status).toBe(200);
    expect(calls[0]).toBe('POST /api/session-action/disconnect/mac/3c%3A22%3Afb%3A41%3A0a%3A19');
    expect(JSON.parse(bodies[0] as string)).toEqual({ async: false });
  });

  it('forwards a configured enforcement profile', async () => {
    const { adapter, bodies } = makeAdapter(() => ({ status: 200, body: {} }), {
      ...CREDS,
      coaEnforcementProfile: 'Quarantine',
    });
    await adapter.coaDisconnect('3c:22:fb:41:0a:19');
    expect(JSON.parse(bodies[0] as string)).toEqual({ async: false, enforcement_profile: 'Quarantine' });
  });
});

// -- Registry wiring --------------------------------------------------------------------

describe('registry wiring', () => {
  async function buildRegistry(creds: Record<string, string>) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hpe-clearpass-'));
    process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
    try {
      const { SettingsStore } = await import('../src/config/settings');
      const { PlaneRegistry } = await import('../src/planes/registry');
      const store = new SettingsStore();
      store.update({ planes: { clearpass: creds } });
      const reg = new PlaneRegistry(store);
      return { adapter: reg.get('clearpass'), state: reg.state('clearpass') };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.HPE_SETTINGS_PATH;
    }
  }

  it('builds the real ClearPassAdapter when credentials are complete', async () => {
    const { adapter, state } = await buildRegistry({ host: 'https://cppm.example.com', token: 'shh' });
    expect(adapter).toBeInstanceOf(ClearPassAdapter);
    expect(state.linked).toBe(true);
    expect(state.health).toBe('warning');
    expect(state.note).toBe('credentials saved — first sync pending');
  });

  it('builds the real adapter from the exact payload the connect drawer saves', async () => {
    // publisher + clientId + clientSecret — no host, no pre-minted token.
    const { adapter, state } = await buildRegistry({
      displayName: 'ClearPass',
      publisher: 'cppm-01.meridian.health',
      clientId: 'portal-insight',
      clientSecret: 'vault-secret',
      scopes: 'read:session,read:endpoint,read:policy',
    });
    expect(adapter).toBeInstanceOf(ClearPassAdapter);
    expect(state.note).toBe('credentials saved — first sync pending');
  });
});

// -- Reviewed direct writes (endpoint register/update, local-user create/update) --
//
// The plane-facing half of services/clearpassDirectWrite.ts: the exact CPPM
// payload shape, the read-back verify (tri-state — found / absent / unreadable),
// the refusal path that reports instead of throwing, the cache invalidation a
// landed write owes the poller, and the password discipline — a local-user
// password crosses in the outbound request body and NOWHERE else.

describe('ClearPassAdapter reviewed writes', () => {
  /** The endpoint row the fake CPPM serves on read-back. */
  const EP_ROW = {
    id: '301',
    mac_address: '3c:22:fb:41:0a:19',
    status: 'Known',
    description: 'Ward 3E infusion pump',
    attributes: { Category: 'Computer', 'Device Name': 'pump-3e-01' },
  };

  it('capabilities() claims the reviewed direct writes (never policy editing)', () => {
    const { adapter } = makeAdapter(() => undefined);
    expect(adapter.capabilities()).toEqual({
      localShell: false,
      brokeredWrite: false,
      configRead: false,
      directWrite: true,
    });
  });

  it('registerEndpoint POSTs the CPPM shape and confirms with a read-back by id', async () => {
    const { adapter, calls, bodies, recorded } = makeAdapter((method, pathname, _q, body) => {
      if (method === 'POST' && pathname === '/api/endpoint') {
        expect(body).toEqual({
          mac_address: '3c:22:fb:41:0a:19',
          status: 'Known',
          description: 'Ward 3E infusion pump',
          attributes: { Category: 'Computer' },
        });
        return { status: 201, body: { ...EP_ROW } };
      }
      if (method === 'GET' && pathname === '/api/endpoint/301') return { body: { ...EP_ROW } };
      return undefined;
    });
    const r = await adapter.registerEndpoint({
      mac: '3c:22:fb:41:0a:19',
      description: 'Ward 3E infusion pump',
      status: 'Known',
      attributes: { Category: 'Computer' },
    });
    expect(r).toMatchObject({ ok: true, action: 'created', verified: true, httpCode: 201 });
    expect(r.message).toContain('confirmed');
    expect(calls.some((c) => c.startsWith('GET /api/endpoint/301'))).toBe(true);
    expect(bodies.filter((b) => b !== null)).toHaveLength(1); // the POST, nothing else carries a body
    // The call log keeps its method+path+ms+status discipline on writes too.
    expect(recorded.some((c) => c.path === 'POST /api/endpoint' && c.code === '201')).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain('cppm-token-shh');
  });

  it('registerEndpoint defaults the status and falls back to a MAC filter read-back', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) => {
      if (method === 'POST' && pathname === '/api/endpoint') return { status: 200, body: {} }; // no id in the answer
      if (method === 'GET' && pathname === '/api/endpoint') {
        return { body: { count: 1, _links: {}, _embedded: { items: [{ ...EP_ROW }] } } };
      }
      return undefined;
    });
    const r = await adapter.registerEndpoint({ mac: '3c:22:fb:41:0a:19' });
    expect(r).toMatchObject({ ok: true, action: 'created', verified: true });
    const filterCall = calls.find((c) => c.startsWith('GET /api/endpoint?filter='));
    expect(filterCall).toBeDefined();
    expect(decodeURIComponent(filterCall as string)).toContain('"mac_address":{"$eq":"3c:22:fb:41:0a:19"}');
  });

  it('registerEndpoint reports a refusal as a failed outcome, never thrown', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) => {
      if (method === 'POST' && pathname === '/api/endpoint') {
        return { status: 422, body: { error: 'duplicate mac — a vendor body that must not be echoed' } };
      }
      return undefined;
    });
    const r = await adapter.registerEndpoint({ mac: '3c:22:fb:41:0a:19', status: 'Known' });
    expect(r).toEqual({
      ok: false,
      action: 'failed',
      httpCode: 422,
      message: 'ClearPass refused the endpoint registration (HTTP 422)',
    });
    expect(JSON.stringify(r)).not.toContain('vendor body');
    expect(calls.filter((c) => c.startsWith('GET /api/endpoint'))).toHaveLength(0); // no read-back after a refusal
  });

  it('registerEndpoint reports an unmakeable read-back as verified:undefined — never a guess', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'POST' && pathname === '/api/endpoint') return { status: 201, body: { id: '301' } };
      if (method === 'GET' && pathname === '/api/endpoint/301') return { status: 500, body: {} };
      return undefined;
    });
    const r = await adapter.registerEndpoint({ mac: '3c:22:fb:41:0a:19' });
    expect(r.ok).toBe(true);
    expect(r.verified).toBeUndefined();
    expect(r.message).toContain('read-back could not be made');
  });

  it('updateEndpoint PATCHes only the changed fields and verifies them', async () => {
    const { adapter, bodies } = makeAdapter((method, pathname, _q, body) => {
      if (method === 'PATCH' && pathname === '/api/endpoint/301') {
        expect(body).toEqual({ status: 'Disabled', description: 'access revoked' });
        return { status: 200, body: {} };
      }
      if (method === 'GET' && pathname === '/api/endpoint/301') {
        return { body: { ...EP_ROW, status: 'Disabled', description: 'access revoked' } };
      }
      return undefined;
    });
    const r = await adapter.updateEndpoint('301', { status: 'Disabled', description: 'access revoked' });
    expect(r).toMatchObject({ ok: true, action: 'updated', verified: true, httpCode: 200 });
    expect(bodies.filter((b) => b !== null)).toHaveLength(1);
  });

  it('updateEndpoint flags a read-back that does not show the write (accepted, not landed)', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'PATCH' && pathname === '/api/endpoint/301') return { status: 200, body: {} };
      if (method === 'GET' && pathname === '/api/endpoint/301') return { body: { ...EP_ROW } }; // still Known
      return undefined;
    });
    const r = await adapter.updateEndpoint('301', { status: 'Disabled' });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.message).toContain('read-back does not show it');
  });

  it('a landed endpoint write drops the cached repository reads, so the next pull re-reads', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/api/session') return { body: hal([]) };
      if (method === 'GET' && pathname === '/api/endpoint') {
        return { body: { count: 1, _links: {}, _embedded: { items: [{ ...EP_ROW }] } } };
      }
      if (method === 'POST' && pathname === '/api/endpoint') return { status: 201, body: { ...EP_ROW } };
      if (method === 'GET' && pathname === '/api/endpoint/301') return { body: { ...EP_ROW } };
      return undefined;
    });
    const collectionReads = () => calls.filter((c) => c.startsWith('GET /api/endpoint?')).length;
    await adapter.pull();
    expect(collectionReads()).toBeGreaterThan(0);
    const before = collectionReads();
    await adapter.registerEndpoint({ mac: '3c:22:fb:41:0a:19' });
    // The write's own filter read-back does not apply here (id was in the
    // answer) — any NEW collection read can only come from a re-pull.
    const afterWrite = collectionReads();
    await adapter.pull();
    expect(collectionReads()).toBeGreaterThan(afterWrite);
    expect(afterWrite).toBe(before); // the write itself read back by id, not the collection
  });

  it('createLocalUser sends the password in the request body and NOWHERE else', async () => {
    const PASSWORD = 'c4nary-password-never-echoed';
    const { adapter, bodies, recorded } = makeAdapter((method, pathname, _q, body) => {
      if (method === 'POST' && pathname === '/api/local-user') {
        expect(body).toEqual({
          user_id: 'noc-operator',
          role_name: 'IT admin',
          enabled: true,
          password: PASSWORD,
          username: 'NOC Operator',
        });
        return { status: 201, body: { id: '77' } };
      }
      if (method === 'GET' && pathname === '/api/local-user/77') {
        // A poisoned read-back: CPPM must never send this, but the whitelist
        // is what PROVES a hash cannot ride the row even if one arrives.
        return {
          body: { id: '77', user_id: 'noc-operator', role_name: 'IT admin', enabled: true, password: 'hash-material-shh' },
        };
      }
      return undefined;
    });
    const r = await adapter.createLocalUser({
      userId: 'noc-operator',
      username: 'NOC Operator',
      roleName: 'IT admin',
      enabled: true,
      password: PASSWORD,
    });
    expect(r).toMatchObject({ ok: true, action: 'created', verified: true });
    // Sent: exactly one body carries it — the POST.
    expect(bodies.filter((b) => b !== null && b.includes(PASSWORD))).toHaveLength(1);
    // Never logged, never in the result, and the poisoned hash never crossed.
    expect(JSON.stringify(recorded)).not.toContain(PASSWORD);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(JSON.stringify(r)).not.toContain('hash-material-shh');
    expect(JSON.stringify(recorded)).not.toContain('hash-material-shh');
  });

  it('createLocalUser flags a read-back whose role does not match the write', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'POST' && pathname === '/api/local-user') return { status: 201, body: { id: '77' } };
      if (method === 'GET' && pathname === '/api/local-user/77') {
        return { body: { id: '77', user_id: 'noc-operator', role_name: 'Guest Sponsor', enabled: true } };
      }
      return undefined;
    });
    const r = await adapter.createLocalUser({
      userId: 'noc-operator',
      roleName: 'IT admin',
      enabled: true,
      password: 'x'.repeat(8),
    });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(false);
  });

  it('updateLocalUser sends only the changing fields — the password only when it changes', async () => {
    const seen: unknown[] = [];
    const { adapter } = makeAdapter((method, pathname, _q, body) => {
      if (method === 'PUT' && pathname === '/api/local-user/77') {
        seen.push(body);
        return { status: 200, body: {} };
      }
      if (method === 'GET' && pathname === '/api/local-user/77') {
        return { body: { id: '77', user_id: 'noc-operator', role_name: 'Guest Sponsor', enabled: false } };
      }
      return undefined;
    });
    const r1 = await adapter.updateLocalUser('77', { enabled: false });
    expect(seen[0]).toEqual({ enabled: false }); // no password key at all
    expect(r1).toMatchObject({ ok: true, action: 'updated', verified: true });

    const r2 = await adapter.updateLocalUser('77', { roleName: 'Guest Sponsor', password: 'n3w-password-shh' });
    expect(seen[1]).toEqual({ role_name: 'Guest Sponsor', password: 'n3w-password-shh' });
    expect(r2.ok).toBe(true);
    expect(JSON.stringify(r2)).not.toContain('n3w-password-shh');
  });

  it('a landed local-user write drops the cached inventory read', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/api/session') return { body: hal([]) };
      if (method === 'GET' && pathname === '/api/local-user' && method === 'GET') {
        return { body: { count: 0, _links: {}, _embedded: { items: [] } } };
      }
      if (method === 'POST' && pathname === '/api/local-user') return { status: 201, body: { id: '77' } };
      if (method === 'GET' && pathname === '/api/local-user/77') {
        return { body: { id: '77', user_id: 'noc-operator', role_name: 'IT admin', enabled: true } };
      }
      return undefined;
    });
    const collectionReads = () => calls.filter((c) => c.startsWith('GET /api/local-user?')).length;
    await adapter.pull();
    const before = collectionReads();
    expect(before).toBeGreaterThan(0);
    await adapter.createLocalUser({ userId: 'noc-operator', roleName: 'IT admin', enabled: true, password: 'x'.repeat(8) });
    const afterWrite = collectionReads();
    await adapter.pull();
    expect(collectionReads()).toBeGreaterThan(afterWrite); // re-read, not the cache
  });
});
