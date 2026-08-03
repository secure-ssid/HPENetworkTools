/**
 * server/tests/aoscx.test.ts — AOS-CX adapter unit tests, NO network.
 *
 * mapAosCxPort / mapAosCxCounters are tested against AOS-CX-style depth=2
 * interface tables inlined here; AosCxAdapter.pull() and .deviceDetail() are
 * exercised end-to-end with an in-memory fake `fetch` (FetchLike injection) to
 * cover the session-cookie login flow, the interfaces/counters detail read,
 * the 'failed'/'empty'/references-only section outcomes, and the one
 * re-login retry on a 401.
 */

import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { FetchLike } from '../src/planes/aoscx';
import { AosCxAdapter, mapAosCxPort, mapAosCxSwitch } from '../src/planes/aoscx';

// -- Recorded fixtures (shapes as the v10.12 REST API returns them) -----------

const SYSTEM = {
  hostname: 'sw-core-a',
  platform_name: '8325-48Y8C',
  software_version: 'FL.10.13.1005',
  serial_number: 'SG09KLM4X2',
  management_interface: { ip_address: '10.42.8.11/24' },
};

/** One physical access port, up, with the full statistics map. */
const PORT_UP = {
  name: '1/1/14',
  type: 'system',
  admin_state: 'up',
  link_state: 'up',
  link_speed: 1_000_000_000,
  duplex: 'full',
  mtu: 9198,
  description: 'ap-3f-12',
  vlan_mode: 'access',
  vlan_tag: '/rest/v10.12/system/vlans/812',
  vlan_trunks: {},
  statistics: {
    rx_bytes: 412_000_000_000,
    tx_bytes: 1_280_000_000_000,
    rx_packets: 512_000_000,
    tx_packets: 1_400_000_000,
    rx_errors: 0,
    tx_errors: 0,
    rx_dropped: 0,
    tx_dropped: 0,
  },
};

/** A down port: link_speed 0 as the switch reports it, counters frozen. */
const PORT_DOWN = {
  name: '1/1/22',
  type: 'system',
  admin_state: 'up',
  link_state: 'down',
  link_speed: 0,
  duplex: '',
  mtu: 9198,
  vlan_mode: 'access',
  vlan_tag: '/rest/v10.12/system/vlans/99',
  vlan_trunks: {},
  statistics: {
    rx_bytes: 86_000_000_000,
    tx_bytes: 4_100_000_000,
    rx_packets: 64_000_000,
    tx_packets: 31_000_000,
    rx_errors: 0,
    tx_errors: 0,
    rx_dropped: 0,
    tx_dropped: 0,
  },
};

/** A trunk LAG with tagged VLANs and a nonzero fault count. */
const LAG_UP = {
  name: 'lag1',
  type: 'lag',
  admin_state: 'up',
  link_state: 'up',
  link_speed: 20_000_000_000,
  duplex: 'full',
  vlan_mode: 'trunk',
  vlan_tag: '/rest/v10.12/system/vlans/1',
  vlan_trunks: {
    '8': '/rest/v10.12/system/vlans/8',
    '812': '/rest/v10.12/system/vlans/812',
  },
  statistics: {
    rx_bytes: 31_482_000_000_000,
    tx_bytes: 28_913_000_000_000,
    rx_packets: 24_600_000_000,
    tx_packets: 22_800_000_000,
    rx_errors: 3,
    tx_errors: 0,
    rx_dropped: 27,
    tx_dropped: 0,
  },
};

function state(): PlaneState {
  return { id: 'local', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { baseUrl: 'https://10.42.8.11', username: 'portal-read', password: 's3cret' };

/** What the fake fetch records so header/auth material can be asserted. */
interface Seen {
  urls: string[];
  loginBodies: string[];
  cookies: Array<string | null>;
}

function seenLog(): Seen {
  return { urls: [], loginBodies: [], cookies: [] };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Fake fetch answering the login POST and the REST GETs. `interfacesBodies`
 * are served in order (last one repeats) so a test can answer 401-then-200;
 * `interfacesRaw` takes precedence and sends the text verbatim, for the
 * non-JSON body case.
 */
function fakeFetch(opts: {
  seen?: Seen;
  loginStatus?: number;
  /** Session ids handed out per login, in order (last one repeats). */
  sessionIds?: string[];
  systemBodies?: Array<{ status: number; body: unknown }>;
  interfacesBodies?: Array<{ status: number; body: unknown }>;
  interfacesRaw?: Array<{ status: number; text: string }>;
  vlanBodies?: Array<{ status: number; body: unknown }>;
}): FetchLike {
  const systemBodies = opts.systemBodies ?? [{ status: 200, body: SYSTEM }];
  const interfacesBodies = opts.interfacesBodies ?? [{ status: 200, body: { '1/1/14': PORT_UP } }];
  const vlanBodies = opts.vlanBodies ?? [{ status: 200, body: { '1': {}, '8': {}, '812': {} } }];
  const sessionIds = opts.sessionIds ?? ['sess-1'];
  let loginIdx = 0;
  let systemIdx = 0;
  let interfacesIdx = 0;
  let vlanIdx = 0;
  return async (url, init) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (opts.seen) {
      opts.seen.urls.push(u);
      if (u.includes('/rest/v10.12/login') && typeof init?.body === 'string') opts.seen.loginBodies.push(init.body);
      if (init?.method === 'GET') opts.seen.cookies.push(headers.cookie ?? null);
    }
    if (u.endsWith('/rest/v10.12/login')) {
      const status = opts.loginStatus ?? 200;
      const sid = sessionIds[Math.min(loginIdx, sessionIds.length - 1)];
      loginIdx += 1;
      return jsonResponse(status, {}, { 'set-cookie': `session_id=token-${sid}; Path=/; HttpOnly` });
    }
    if (u.endsWith('/rest/v10.12/logout')) return jsonResponse(200, {});
    if (u.includes('/rest/v10.12/system/interfaces')) {
      const idx = Math.min(interfacesIdx, interfacesBodies.length - 1);
      interfacesIdx += 1;
      if (opts.interfacesRaw) {
        const raw = opts.interfacesRaw[Math.min(idx, opts.interfacesRaw.length - 1)];
        return new Response(raw.text, { status: raw.status, headers: { 'content-type': 'text/html' } });
      }
      const { status, body } = interfacesBodies[idx];
      return jsonResponse(status, body);
    }
    if (u.includes('/rest/v10.12/system/vlans')) {
      const { status, body } = vlanBodies[Math.min(vlanIdx, vlanBodies.length - 1)];
      vlanIdx += 1;
      return jsonResponse(status, body);
    }
    if (u.endsWith('/rest/v10.12/system')) {
      const { status, body } = systemBodies[Math.min(systemIdx, systemBodies.length - 1)];
      systemIdx += 1;
      return jsonResponse(status, body);
    }
    return jsonResponse(404, {});
  };
}

function adapter(fetchImpl: FetchLike, stateRef: PlaneState = state()): AosCxAdapter {
  return new AosCxAdapter('local', stateRef, CREDS, () => {}, fetchImpl);
}

// ---------------------------------------------------------------------------
// mapAosCxPort — the pure mapping, malformed and partial shapes included
// ---------------------------------------------------------------------------

describe('mapAosCxPort', () => {
  it('maps a full depth=2 interface: states, speed, VLANs and counters', () => {
    const port = mapAosCxPort('1/1/14', PORT_UP);
    expect(port).toMatchObject({
      name: '1/1/14',
      status: 'up',
      adminStatus: 'up',
      operStatus: 'up',
      speedBps: 1_000_000_000,
      duplex: 'full',
      mtu: 9198,
      vlanMode: 'access',
      nativeVlan: 812,
      allowedVlanIds: [],
      counters: {
        rxBytes: 412_000_000_000,
        txBytes: 1_280_000_000_000,
        rxPackets: 512_000_000,
        txPackets: 1_400_000_000,
        rxErrors: 0,
        txErrors: 0,
        rxDropped: 0,
        txDropped: 0,
      },
    });
  });

  it('keeps tagged VLAN ids off the vlan_trunks map keys, dropping named trunks', () => {
    const port = mapAosCxPort('lag1', {
      ...LAG_UP,
      vlan_trunks: { '8': '/rest/v10.12/system/vlans/8', '812': '/rest/v10.12/system/vlans/812', guest: '/rest/v10.12/system/vlans/guest' },
    });
    expect(port?.allowedVlanIds).toEqual([8, 812]);
    expect(port?.nativeVlan).toBe(1);
  });

  it('reads an expanded vlan_tag object as well as a URI reference', () => {
    const port = mapAosCxPort('1/1/9', { ...PORT_UP, name: '1/1/9', vlan_tag: { '200': {} } });
    expect(port?.nativeVlan).toBe(200);
  });

  it('reports a missing statistics map as NO counters key — never as zeros', () => {
    const { statistics: _drop, ...withoutStats } = PORT_UP;
    const port = mapAosCxPort('1/1/14', withoutStats);
    expect(port).not.toBeNull();
    expect('counters' in port!).toBe(false);
  });

  it('reads a statistics map missing a counter as null, never as 0', () => {
    const port = mapAosCxPort('1/1/14', {
      ...PORT_UP,
      statistics: { rx_bytes: 100, tx_bytes: '2048' }, // numeric strings tolerated
    });
    expect(port?.counters).toMatchObject({
      rxBytes: 100,
      txBytes: 2048,
      rxPackets: null,
      rxErrors: null,
      txDropped: null,
    });
  });

  it('takes the interface name from the map key when the attribute is absent', () => {
    const { name: _drop, ...anonymous } = PORT_UP;
    expect(mapAosCxPort('1/1/14', anonymous)?.name).toBe('1/1/14');
  });

  it('refuses a non-object entry (a depth-1 URI reference is not attributes)', () => {
    expect(mapAosCxPort('1/1/14', '/rest/v10.12/system/interfaces/1%2F1%2F14')).toBeNull();
    expect(mapAosCxPort('1/1/14', null)).toBeNull();
    expect(mapAosCxPort('1/1/14', ['not', 'an', 'object'])).toBeNull();
  });

  it('keeps a down link_speed of 0 as 0 — reported, distinct from absent', () => {
    expect(mapAosCxPort('1/1/22', PORT_DOWN)?.speedBps).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deviceDetail — the on-demand interfaces + counters read
// ---------------------------------------------------------------------------

describe('AosCxAdapter.deviceDetail', () => {
  it('returns the interface table with counters, physically ordered', async () => {
    const seen = seenLog();
    const a = adapter(fakeFetch({ interfacesBodies: [{ status: 200, body: { '1/1/22': PORT_DOWN, lag1: LAG_UP, '1/1/14': PORT_UP } }], seen }));
    const detail = await a.deviceDetail('SG09KLM4X2', 'switch');
    expect(detail).not.toBeNull();
    expect(detail?.source.plane).toBe('local');
    expect(detail?.source.sections.ports).toBe('ok');
    expect(Number.isNaN(Date.parse(detail?.source.at ?? ''))).toBe(false);
    expect(detail?.ports?.map((p) => p.name)).toEqual(['1/1/14', '1/1/22', 'lag1']);
    expect(detail?.ports?.[0]?.counters?.rxBytes).toBe(412_000_000_000);
    expect(detail?.ports?.[2]?.counters).toMatchObject({ rxErrors: 3, rxDropped: 27 });
    expect(detail?.source.note ?? null).toBeNull();
  });

  it('authenticates once, then sends the issued session cookie on the GET', async () => {
    const seen = seenLog();
    const a = adapter(fakeFetch({ seen }));
    await a.deviceDetail('SG09KLM4X2', 'switch');
    expect(seen.loginBodies).toHaveLength(1);
    expect(seen.loginBodies[0]).toContain('username=portal-read');
    // The cookie sent back is the one the switch issued, verbatim.
    expect(seen.cookies).toEqual(['session_id=token-sess-1']);
  });

  it('re-logs in and retries once when the read answers 401', async () => {
    const seen = seenLog();
    const a = adapter(
      fakeFetch({
        sessionIds: ['sess-1', 'sess-2'],
        interfacesBodies: [
          { status: 401, body: {} },
          { status: 200, body: { '1/1/14': PORT_UP } },
        ],
        seen,
      }),
    );
    const detail = await a.deviceDetail('SG09KLM4X2', 'switch');
    expect(detail?.source.sections.ports).toBe('ok');
    expect(seen.loginBodies).toHaveLength(2);
    // The retry carries the SECOND session, not the dead one.
    expect(seen.cookies).toEqual(['session_id=token-sess-1', 'session_id=token-sess-2']);
  });

  it('marks the section failed — with the reason named — when the read breaks', async () => {
    const a = adapter(fakeFetch({ interfacesBodies: [{ status: 500, body: {} }] }));
    const detail = await a.deviceDetail('SG09KLM4X2', 'switch');
    expect(detail?.source.sections.ports).toBe('failed');
    expect(detail?.ports).toBeUndefined();
    expect(detail?.source.note).toContain('HTTP 500');
  });

  it('marks the section failed when the switch sends no JSON', async () => {
    const a = adapter(fakeFetch({ interfacesRaw: [{ status: 200, text: '<html>Web UI</html>' }] }));
    const detail = await a.deviceDetail('SG09KLM4X2', 'switch');
    expect(detail?.source.sections.ports).toBe('failed');
    expect(detail?.source.note).toContain('non-JSON body');
  });

  it('fails the section rather than listing name-only rows when no attributes came back', async () => {
    // A firmware that will not honour depth=2 answers name → URI references:
    // real names, zero attributes. Listed, that table would read as "every
    // port down" — which this read does not know.
    const a = adapter(
      fakeFetch({
        interfacesBodies: [
          {
            status: 200,
            body: {
              '1/1/14': '/rest/v10.12/system/interfaces/1%2F1%2F14',
              '1/1/22': '/rest/v10.12/system/interfaces/1%2F1%2F22',
            },
          },
        ],
      }),
    );
    const detail = await a.deviceDetail('SG09KLM4X2', 'switch');
    expect(detail?.source.sections.ports).toBe('failed');
    expect(detail?.source.note).toContain('none carried readable attributes');
    expect(detail?.ports).toBeUndefined();
  });

  it('reports an empty table as empty — the switch answered, and has no interfaces', async () => {
    const a = adapter(fakeFetch({ interfacesBodies: [{ status: 200, body: {} }] }));
    const detail = await a.deviceDetail('SG09KLM4X2', 'switch');
    expect(detail?.source.sections.ports).toBe('empty');
    expect(detail?.ports).toEqual([]);
  });

  it('says counters are not reported when no interface carried a statistics map', async () => {
    const { statistics: _s1, ...p14 } = PORT_UP;
    const { statistics: _s2, ...p22 } = PORT_DOWN;
    const a = adapter(fakeFetch({ interfacesBodies: [{ status: 200, body: { '1/1/14': p14, '1/1/22': p22 } }] }));
    const detail = await a.deviceDetail('SG09KLM4X2', 'switch');
    expect(detail?.source.sections.ports).toBe('ok');
    expect(detail?.ports).toHaveLength(2);
    expect(detail?.source.note).toContain('counters not reported');
  });

  it('skips malformed entries without failing the interfaces that parsed', async () => {
    const a = adapter(
      fakeFetch({
        interfacesBodies: [{ status: 200, body: { '1/1/14': PORT_UP, '1/1/99': null, '1/1/98': 'junk' } }],
      }),
    );
    const detail = await a.deviceDetail('SG09KLM4X2', 'switch');
    expect(detail?.source.sections.ports).toBe('ok');
    expect(detail?.ports?.map((p) => p.name)).toEqual(['1/1/14']);
  });

  it('claims nothing for a kind this plane has no subresource for, or an empty serial', async () => {
    const seen = seenLog();
    const a = adapter(fakeFetch({ seen }));
    expect(await a.deviceDetail('SG09KLM4X2', 'ap')).toBeNull();
    expect(await a.deviceDetail('SG09KLM4X2', 'gateway')).toBeNull();
    expect(await a.deviceDetail('  ', 'switch')).toBeNull();
    // No call was spent on any of them.
    expect(seen.urls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pull() — the one device row this plane publishes, unchanged by the new read
// ---------------------------------------------------------------------------

describe('AosCxAdapter.pull', () => {
  it('publishes the switch row and names the interface/VLAN counts', async () => {
    const stateRef = state();
    const a = adapter(fakeFetch({ interfacesBodies: [{ status: 200, body: { '1/1/14': PORT_UP, '1/1/22': PORT_DOWN, lag1: LAG_UP } }] }), stateRef);
    const pull = await a.pull();
    expect(pull.devices).toHaveLength(1);
    expect(mapAosCxSwitch(SYSTEM, null)).toMatchObject({ name: 'sw-core-a', plane: 'LOCAL', type: 'switch' });
    expect(pull.devices?.[0]).toMatchObject({ name: 'sw-core-a', serial: 'SG09KLM4X2', ip: '10.42.8.11' });
    expect(stateRef.note).toBe('1 switch · 3 interfaces · 3 VLANs');
    expect(stateRef.health).toBe('healthy');
  });

  it('degrades the note — not the row — when the interfaces read fails', async () => {
    const stateRef = state();
    const a = adapter(fakeFetch({ interfacesBodies: [{ status: 500, body: {} }] }), stateRef);
    const pull = await a.pull();
    expect(pull.devices).toHaveLength(1);
    expect(stateRef.note).toContain('interfaces unavailable');
    expect(stateRef.note).toContain('3 VLANs');
    expect(stateRef.health).toBe('warning');
  });
});
