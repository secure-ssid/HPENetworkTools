/**
 * server/tests/client360.test.ts — the Client 360 correlation itself.
 *
 * clientPlaneSections() is shared/logic.ts, so these run against the one
 * implementation the server's demo branch AND the browser's offline fallback
 * both call — a drift between the two is impossible by construction, and these
 * tests are what keep the join honest:
 *
 *   - MAC normalization is the join key, in every notation a plane has ever
 *     emitted;
 *   - a section is present-with-data or absent-with-an-honest-reason, never
 *     silently missing;
 *   - "not read" and "none" are different sentences (the unread map);
 *   - the roster's cross-plane dedupe is NOT applied here — two planes
 *     reporting one MAC is the answer, not a duplicate.
 */

import { describe, expect, it } from 'vitest';
import {
  CLIENT_360_AUTH_EVENT_LIMIT,
  CLIENT_360_PLANES,
  clientPlaneSections,
  demoClient360World,
  normalizeMac,
  type AuthEventRow,
  type Client360World,
  type ClientRow,
  type EndpointRow,
  type MistSleRow,
} from '@hpe/shared';

const MAC = '3c:22:fb:41:0a:19';

function session(mac: string, plane: ClientRow['plane'], over: Partial<ClientRow> = {}): ClientRow {
  return {
    name: `client-via-${plane.toLowerCase()}`,
    model: 'ThinkPad X1',
    type: 'laptop',
    group: 'default',
    mac,
    ip: '10.1.4.55',
    attach: 'ap-1',
    where: 'radio 1',
    plane,
    planeTone: 'neutral',
    auth: '802.1X',
    authBy: 'clearpass',
    role: 'employee',
    vlan: '110',
    health: 'good',
    healthTone: 'success',
    session: '2h',
    medium: 'wireless',
    siteId: 'campus-01',
    siteName: 'Campus-01 — Meridian HQ',
    problem: false,
    link: '5 GHz · ch 36',
    rssi: '−52 dBm',
    snr: '38 dB',
    retries: '2%',
    tput: '120 Mbps',
    roams: '1',
    quality: 88,
    zone: '3rd floor',
    closet: 'IDF-3',
    ...over,
  };
}

function authEvent(mac: string, over: Partial<AuthEventRow> = {}): AuthEventRow {
  return {
    time: '09:41:22',
    who: 'm.okonjo',
    mac,
    service: 'MRDN Wireless 802.1X',
    method: 'EAP-TLS',
    result: 'accept',
    tone: 'success',
    reason: 'Certificate valid',
    role: 'role Clinical staff · vlan 820',
    nas: 'ap-1',
    plane: 'CLEARPASS',
    ...over,
  };
}

function endpoint(mac: string, over: Partial<EndpointRow> = {}): EndpointRow {
  return {
    id: 'ep-x',
    mac,
    description: null,
    ip: '10.1.4.55',
    hostname: 'client-1',
    status: 'Known',
    category: 'Computer',
    family: 'Windows',
    os: 'Windows 11',
    profile: 'employee',
    updatedAt: '2 minutes ago',
    ...over,
  };
}

const SLE: MistSleRow = {
  siteId: 'campus-01',
  siteName: 'Campus-01 — Meridian HQ',
  coverage: 0.97,
  capacity: 0.95,
  roaming: 0.96,
  apHealth: 0.98,
  wan: null,
  overall: 0.96,
};

function world(over: Partial<Client360World> = {}): Client360World {
  return { sessions: [], authEvents: [], endpoints: [], mistSle: [], ...over };
}

/** The section answering for one plane, or a failed expectation. */
function section(sections: ReturnType<typeof clientPlaneSections>, plane: string) {
  const found = sections.find((s) => s.plane === plane);
  if (!found) throw new Error(`no section for ${plane}`);
  return found;
}

describe('normalizeMac', () => {
  it('joins every notation a plane emits onto one key', () => {
    expect(normalizeMac('3C:22:FB:41:0A:19')).toBe(MAC);
    expect(normalizeMac('3c22.fb41.0a19')).toBe(MAC);
    expect(normalizeMac('3c22fb410a19')).toBe(MAC);
    expect(normalizeMac('3C-22-FB-41-0A-19')).toBe(MAC);
  });

  it('passes non-12-hex values through lowercased rather than guessing', () => {
    expect(normalizeMac('AA:BB')).toBe('aa:bb');
    expect(normalizeMac(' not-a-mac ')).toBe('not-a-mac');
  });
});

describe('clientPlaneSections over the demo world', () => {
  const sections = clientPlaneSections(MAC, 'campus-02', demoClient360World());

  it('answers for every registry plane — absence is a stated fact, not a missing row', () => {
    expect(sections).toHaveLength(CLIENT_360_PLANES.length);
    expect(sections.map((s) => s.plane).sort()).toEqual([...CLIENT_360_PLANES].sort());
  });

  it('correlates the fixture client across Mist (session + site SLE) and ClearPass (endpoint + decisions)', () => {
    const mist = section(sections, 'mist');
    expect(mist.state).toBe('ok');
    expect(mist.session?.mac).toBe(MAC);
    expect(mist.siteSle?.siteId).toBe('campus-02');
    expect(mist.reason).toContain('site-level');

    const clearpass = section(sections, 'clearpass');
    expect(clearpass.state).toBe('ok');
    expect(clearpass.endpoint?.id).toBe('ep-001');
    // Two decisions, newest first — the fixture carries a plural list for her.
    expect(clearpass.authEvents?.map((e) => e.time)).toEqual(['09:41:22', '08:12:03']);
  });

  it('words the planes that carry nothing for this MAC', () => {
    // Central is a session plane the demo feed answers for other MACs — for
    // hers the honest sentence is "no session", never "not linked".
    expect(section(sections, 'central')).toMatchObject({
      state: 'empty',
      reason: 'no session reported for this MAC',
    });
    // Structural absences hold in every mode, demo included: they are facts
    // about the plane's data model, not about the feed.
    expect(section(sections, 'uxi').reason).toContain('synthetically');
    expect(section(sections, 'uxi').state).toBe('not-fetched');
    expect(section(sections, 'greenlake').reason).toContain('licences');
    expect(section(sections, 'sse').state).toBe('not-fetched');
  });

  it('orders ok → empty → not-fetched so the planes that see the client read first', () => {
    const ranks = { ok: 0, empty: 1, 'not-fetched': 2 } as const;
    const order = sections.map((s) => ranks[s.state]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sections[0]!.state).toBe('ok');
  });

  it('joins a MAC written in any notation onto the same sections', () => {
    const dotted = clientPlaneSections('3C22.FB41.0A19', 'campus-02', demoClient360World());
    expect(section(dotted, 'mist').state).toBe('ok');
    expect(section(dotted, 'clearpass').authEvents).toHaveLength(2);
  });

  it('an unknown MAC is empty everywhere data planes are concerned, structural elsewhere', () => {
    // The route passes the client row's siteId, so an unknown MAC arrives with
    // none — no site-level join is even attempted.
    const none = clientPlaneSections('aa:aa:aa:aa:aa:aa', null, demoClient360World());
    expect(none.filter((s) => s.state === 'ok')).toHaveLength(0);
    expect(section(none, 'central').state).toBe('empty');
    expect(section(none, 'clearpass').state).toBe('empty');
    expect(section(none, 'uxi').state).toBe('not-fetched');
  });
});

describe('clientPlaneSections over synthetic worlds', () => {
  it('two planes reporting one MAC is the answer, not a duplicate', () => {
    const sections = clientPlaneSections(
      MAC,
      'campus-01',
      world({ sessions: [session(MAC, 'CENTRAL'), session(MAC, 'MIST')] }),
    );
    expect(section(sections, 'central').session?.plane).toBe('CENTRAL');
    expect(section(sections, 'mist').session?.plane).toBe('MIST');
    expect(sections.filter((s) => s.state === 'ok')).toHaveLength(2);
  });

  it('keeps the first sighting per plane — the same winner the roster dedupe picks', () => {
    const sections = clientPlaneSections(
      MAC,
      'campus-01',
      world({
        sessions: [
          session(MAC, 'CENTRAL', { attach: 'ap-first' }),
          session(MAC, 'CENTRAL', { attach: 'ap-second' }),
        ],
      }),
    );
    expect(section(sections, 'central').session?.attach).toBe('ap-first');
  });

  it('a row with no real MAC can never match', () => {
    const sections = clientPlaneSections(
      MAC,
      'campus-01',
      world({ sessions: [session('—', 'CENTRAL')], authEvents: [authEvent('—')] }),
    );
    expect(sections.filter((s) => s.state === 'ok')).toHaveLength(0);
  });

  it('caps the recent-decisions list — the full log is the Auth events screen', () => {
    const many = Array.from({ length: CLIENT_360_AUTH_EVENT_LIMIT + 2 }, (_, i) =>
      authEvent(MAC, { time: `09:4${i}:00` }),
    );
    const sections = clientPlaneSections(MAC, 'campus-01', world({ authEvents: many }));
    expect(section(sections, 'clearpass').authEvents).toHaveLength(CLIENT_360_AUTH_EVENT_LIMIT);
  });

  it('says how many decisions the cap dropped, not just the ones it kept', () => {
    // Five failures and forty failures are different incidents, and the
    // section shows the same five rows for both. The count is the difference.
    const many = Array.from({ length: 40 }, (_, i) => authEvent(MAC, { time: `09:${i}:00` }));
    const clearpass = section(clientPlaneSections(MAC, 'campus-01', world({ authEvents: many })), 'clearpass');
    expect(clearpass.state).toBe('ok');
    expect(clearpass.reason).toContain('40 auth events');
    expect(clearpass.reason).toContain(`${CLIENT_360_AUTH_EVENT_LIMIT} most recent`);
    expect(clearpass.reason).toContain('Auth events screen');
  });

  it('stays quiet when nothing was dropped — a caveat that is always on says nothing', () => {
    const exact = Array.from({ length: CLIENT_360_AUTH_EVENT_LIMIT }, (_, i) =>
      authEvent(MAC, { time: `09:4${i}:00` }),
    );
    const clearpass = section(clientPlaneSections(MAC, 'campus-01', world({ authEvents: exact })), 'clearpass');
    expect(clearpass.authEvents).toHaveLength(CLIENT_360_AUTH_EVENT_LIMIT);
    expect(clearpass.reason ?? '').not.toContain('most recent');
  });

  it('keeps the dropped-rows count apart from an unread repository', () => {
    const many = Array.from({ length: 12 }, (_, i) => authEvent(MAC, { time: `09:${i}:00` }));
    const clearpass = section(
      clientPlaneSections(MAC, 'campus-01', world({ authEvents: many, unread: { clearpass: ['endpoints'] } })),
      'clearpass',
    );
    // Two different facts about two different datasets, worded apart.
    expect(clearpass.reason).toContain('the endpoint repository was not read this cycle');
    expect(clearpass.reason).toContain('12 auth events');
  });

  it('an unavailable plane is not-fetched with the reason it was given', () => {
    const sections = clientPlaneSections(
      MAC,
      'campus-01',
      world({ unavailable: { central: 'plane not linked' } }),
    );
    expect(section(sections, 'central')).toMatchObject({ state: 'not-fetched', reason: 'plane not linked' });
  });

  it('a linked plane with no client roster is unread, never empty', () => {
    const sections = clientPlaneSections(MAC, 'campus-01', world({ unread: { mist: ['clients'] } }));
    expect(section(sections, 'mist')).toMatchObject({
      state: 'not-fetched',
      reason: 'MIST has not reported a client roster',
    });
  });

  it('words a partial ClearPass read as partial — "none" only for the dataset that answered', () => {
    // Auth log read (no events), repository NOT read: the absence claim covers
    // the events only, and the unread repository is named as unread.
    const partial = clientPlaneSections(
      MAC,
      'campus-01',
      world({ unread: { clearpass: ['endpoints'] } }),
    );
    expect(section(partial, 'clearpass')).toMatchObject({
      state: 'empty',
      reason: 'no auth events for this MAC · the endpoint repository was not read this cycle',
    });

    // Endpoint present, auth log unread: the record shows, and the log's
    // absence rides as a qualifier rather than implying no decisions.
    const withEndpoint = clientPlaneSections(
      MAC,
      'campus-01',
      world({ endpoints: [endpoint(MAC)], unread: { clearpass: ['authEvents'] } }),
    );
    expect(section(withEndpoint, 'clearpass').state).toBe('ok');
    expect(section(withEndpoint, 'clearpass').endpoint?.id).toBe('ep-x');
    expect(section(withEndpoint, 'clearpass').reason).toBe('the auth log was not read this cycle');

    // Neither read: the plane has not answered at all.
    const neither = clientPlaneSections(
      MAC,
      'campus-01',
      world({ unread: { clearpass: ['authEvents', 'endpoints'] } }),
    );
    expect(section(neither, 'clearpass')).toMatchObject({
      state: 'not-fetched',
      reason: 'its auth and endpoint reads have not come back',
    });
  });

  it('Mist with only a site SLE is ok, and says the SLE is the site’s, not the client’s', () => {
    const sections = clientPlaneSections(MAC, 'campus-01', world({ mistSle: [SLE] }));
    const mist = section(sections, 'mist');
    expect(mist.state).toBe('ok');
    expect(mist.session).toBeUndefined();
    expect(mist.siteSle?.overall).toBe(0.96);
    expect(mist.reason).toContain('no session for this MAC');
    expect(mist.reason).toContain('site-level');
  });

  it('no site key, no site-level join — SLE is never matched by MAC', () => {
    const sections = clientPlaneSections(MAC, null, world({ mistSle: [SLE] }));
    expect(section(sections, 'mist').state).toBe('empty');
    expect(section(sections, 'mist').siteSle).toBeUndefined();
  });

  it('another plane’s session does not lend Mist a section, and vice versa', () => {
    const sections = clientPlaneSections(MAC, 'campus-01', world({ sessions: [session(MAC, 'AOS-8')] }));
    expect(section(sections, 'aos8').state).toBe('ok');
    expect(section(sections, 'mist').state).toBe('empty');
  });
});
