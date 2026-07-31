/**
 * server/tests/aos8.test.ts — AOS-8 adapter unit tests, NO network.
 *
 * The mapping helpers are tested against AOS-8-style showcommand tables
 * inlined here; Aos8Adapter.pull() is exercised end-to-end with an in-memory
 * fake `fetch` (FetchLike injection) to cover the UIDARUBA + SESSION cookie
 * login flow, session caching + re-login on 401/403 and on status != "0",
 * table extraction across body shapes, the non-JSON and empty-inventory
 * refusals, the additive client table, section-named failures, and the
 * redacted call log (no UID, no password).
 */

import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { FetchLike } from '../src/planes/aos8';
import {
  Aos8Adapter,
  aos8FirmwareApproved,
  aos8MasterVersion,
  mapAos8Ap,
  mapAos8Client,
  mapAos8Switch,
} from '../src/planes/aos8';

// -- Recorded fixtures (shapes as the MM API returns them) ----------------------

const AP_UP = { Name: 'ap-t1-12', Group: 'lake-tower', 'AP Type': 'AP-535', 'IP Address': '10.48.1.42', Status: 'Up 9d:02:14:03' };
const AP_DOWN = { Name: 'ap-t1-19', Group: 'lake-tower', 'AP Type': 'AP-535', 'IP Address': '10.48.1.57', Status: 'Down' };
const SWITCH_ROW = { Name: 'mc-lake-2', 'IP Address': '10.48.0.12', Model: '7210', Version: '8.10.0.10', Status: 'up', Type: 'MD' };
const USER_ROW = {
  IP: '10.44.12.31',
  MAC: '9c:3e:53:aa:01:22',
  Name: 'k.ortega',
  Role: 'clinical-staff',
  'Age(d:h:m)': '00:04:12',
  Auth: '802.1x',
  'AP name': 'ap-t1-12',
  'Essid/Bssid/Phy': 'MERIDIAN-CLIN/9c:3e:53:aa:0f:10/6GHz',
  Profile: 'clinical-aaa',
  Type: 'Win 11',
};
const USER_ROW_WIRED = { IP: '10.44.9.4', MAC: 'b0:22:7a:11:90:03', Name: 'lab-printer', Role: 'printers', Auth: 'MAC' };

const LOGIN_OK = { _global_result: { status: '0', status_str: 'Login successful', UIDARUBA: 'uid-abc-123' } };

function apDatabaseBody(aps: unknown[]): unknown {
  return { _global_result: { status: '0' }, 'AP Database': aps };
}
function switchesBody(switches: unknown[]): unknown {
  return { _global_result: { status: '0' }, _data: { Switches: switches } }; // nested variant
}
function usersBody(users: unknown[]): unknown {
  return { _global_result: { status: '0' }, 'Global Users': users };
}

function state(): PlaneState {
  return { id: 'aos8', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { master: '10.48.0.10:4343', username: 'portal-read', password: 's3cret' };

/** What the fake fetch records so header/auth material can be asserted. */
interface Seen {
  urls: string[];
  loginBodies: string[];
  cookies: Array<string | null>;
}

function seenLog(): Seen {
  return { urls: [], loginBodies: [], cookies: [] };
}

/** Fake fetch answering the login POST and the three showcommand GETs. */
function fakeFetch(opts: {
  loginStatus?: number;
  loginBodies?: unknown[];
  /** Raw `Set-Cookie` value the login answer carries (undefined = none). */
  loginSetCookie?: string;
  apBodies?: Array<{ status: number; body: unknown }>;
  /** Raw (possibly non-JSON) AP answers — takes precedence over apBodies. */
  apRaw?: Array<{ status: number; text: string }>;
  switchBodies?: Array<{ status: number; body: unknown }>;
  userBodies?: Array<{ status: number; body: unknown }>;
  seen?: Seen;
}): FetchLike {
  const apBodies = opts.apBodies ?? [{ status: 200, body: apDatabaseBody([AP_UP, AP_DOWN]) }];
  const switchBodies = opts.switchBodies ?? [{ status: 200, body: switchesBody([SWITCH_ROW]) }];
  const userBodies = opts.userBodies ?? [{ status: 200, body: usersBody([USER_ROW, USER_ROW_WIRED]) }];
  const loginBodies = opts.loginBodies ?? [LOGIN_OK];
  let loginIdx = 0;
  let apIdx = 0;
  let swIdx = 0;
  let userIdx = 0;
  return async (url, init) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (opts.seen) {
      opts.seen.urls.push(u);
      if (u.includes('showcommand')) opts.seen.cookies.push(headers.cookie ?? null);
      if (u.includes('/v1/api/login') && typeof init?.body === 'string') opts.seen.loginBodies.push(init.body);
    }
    if (u.includes('/v1/api/login')) {
      const status = opts.loginStatus ?? 200;
      const body = loginBodies[Math.min(loginIdx, loginBodies.length - 1)];
      loginIdx += 1;
      return new Response(JSON.stringify(body), {
        status,
        headers: opts.loginSetCookie ? { 'set-cookie': opts.loginSetCookie } : undefined,
      });
    }
    if (u.includes('showcommand') && u.includes(encodeURIComponent('show ap database long'))) {
      if (opts.apRaw) {
        const raw = opts.apRaw[Math.min(apIdx, opts.apRaw.length - 1)];
        apIdx += 1;
        return new Response(raw.text, { status: raw.status, headers: { 'content-type': 'text/html' } });
      }
      const b = apBodies[Math.min(apIdx, apBodies.length - 1)];
      apIdx += 1;
      return new Response(JSON.stringify(b.body), { status: b.status });
    }
    if (u.includes('showcommand') && u.includes(encodeURIComponent('show switches'))) {
      const b = switchBodies[Math.min(swIdx, switchBodies.length - 1)];
      swIdx += 1;
      return new Response(JSON.stringify(b.body), { status: b.status });
    }
    if (u.includes('showcommand') && u.includes(encodeURIComponent('show global-user-table list'))) {
      const b = userBodies[Math.min(userIdx, userBodies.length - 1)];
      userIdx += 1;
      return new Response(JSON.stringify(b.body), { status: b.status });
    }
    return new Response('{}', { status: 404 });
  };
}

function makeAdapter(fetchImpl: FetchLike): { adapter: Aos8Adapter; calls: Array<{ path: string; code: string }>; st: PlaneState } {
  const calls: Array<{ path: string; code: string }> = [];
  const st = state();
  const adapter = new Aos8Adapter(CREDS, st, (c) => calls.push({ path: c.path, code: c.code }), fetchImpl);
  return { adapter, calls, st };
}

// -- mapping ---------------------------------------------------------------------

describe('mapAos8Ap', () => {
  it('maps an up AP from the database table', () => {
    expect(mapAos8Ap(AP_UP)).toMatchObject({
      name: 'ap-t1-12',
      model: 'AP-535',
      type: 'ap',
      plane: 'AOS-8',
      planeTone: 'accent',
      state: 'up',
      stateTone: 'success',
      // The AP database's Group is the only place column AOS-8 publishes —
      // filing the whole plane under 'multiple' hid it from every site screen.
      siteId: 'ext-lake-tower',
      siteName: 'lake-tower',
      // An AP terminates on its controller: no portal shell.
      localShell: false,
    });
  });

  it("falls back to the 'multiple' pseudo-site when the row carries no Group", () => {
    expect(mapAos8Ap({ Name: 'ap-x', Status: 'Up 1d' })).toMatchObject({ siteId: 'multiple' });
  });

  it('maps down and unknown statuses honestly', () => {
    expect(mapAos8Ap(AP_DOWN)).toMatchObject({ state: 'down', stateTone: 'danger' });
    expect(mapAos8Ap({ Name: 'ap-x', Status: 'unprovisioned' })).toMatchObject({ state: 'unprovisioned', stateTone: 'neutral' });
  });

  it('falls back to the IP for a name and drops nameless rows', () => {
    expect(mapAos8Ap({ 'IP Address': '10.48.9.9', Status: 'Up 1d' })).toMatchObject({ name: '10.48.9.9' });
    expect(mapAos8Ap({ Status: 'Up 1d' })).toBeNull();
    expect(mapAos8Ap(null)).toBeNull();
  });

  // The recorded-SSH terminal dials this address; without it the live gate
  // refuses rather than guessing a fixture IP.
  it('carries the management IP through, and omits it when the table has none', () => {
    expect(mapAos8Ap(AP_UP)?.ip).toBe('10.48.1.42');
    expect(mapAos8Ap({ Name: 'ap-x', Status: 'Up 1d' })?.ip).toBeUndefined();
  });
});

describe('mapAos8Switch', () => {
  it('maps a controller with its version', () => {
    expect(mapAos8Switch(SWITCH_ROW)).toMatchObject({
      name: 'mc-lake-2',
      model: '7210',
      type: 'controller',
      state: 'up',
      stateTone: 'success',
      firmware: '8.10.0.10',
    });
  });

  it('maps a down controller', () => {
    expect(mapAos8Switch({ ...SWITCH_ROW, Status: 'DOWN' })).toMatchObject({ state: 'down', stateTone: 'danger' });
  });

  it('carries the management IP through', () => {
    expect(mapAos8Switch(SWITCH_ROW)?.ip).toBe('10.48.0.12');
  });

  // README: AOS-8 gets recorded SSH through the jump host. Reporting 'no local
  // shell' for an on-prem controller is factually wrong and removes the
  // terminal affordance the plane exists to offer.
  it('offers a recorded shell for a controller and resolves its Location as the site', () => {
    expect(mapAos8Switch({ ...SWITCH_ROW, Location: 'lake-tower' })).toMatchObject({
      localShell: true,
      siteId: 'ext-lake-tower',
    });
    expect(mapAos8Switch(SWITCH_ROW)).toMatchObject({ localShell: true, siteId: 'multiple' });
  });
});

describe('AOS-8 firmware train', () => {
  const MASTER = { Name: 'mm-lake-1', 'IP Address': '10.48.0.10', Type: 'master', Version: '8.10.0.10', Status: 'up' };

  it('reads the approved train off the master row, and nothing when none says master', () => {
    expect(aos8MasterVersion([MASTER, SWITCH_ROW])).toBe('8.10.0.10');
    expect(aos8MasterVersion([SWITCH_ROW])).toBeNull(); // MD only — nothing declared the train
  });

  it('flags an MD that is off the master train and leaves matching peers alone', () => {
    const onTrain = mapAos8Switch(SWITCH_ROW)!; // 8.10.0.10
    const offTrain = mapAos8Switch({ ...SWITCH_ROW, Name: 'mc-lake-3', Version: '8.10.0.9' })!;
    expect(aos8FirmwareApproved(onTrain, '8.10.0.10', [])).toBe(true);
    expect(aos8FirmwareApproved(offTrain, '8.10.0.10', [])).toBe(false);
  });

  // We cannot know, and flagging every AP would be noise, not signal.
  it('never flags unknown firmware, and leaves APs to their controller', () => {
    const ap = mapAos8Ap(AP_UP)!; // the AP database publishes no version
    expect(ap.firmware).toBe('unknown');
    expect(aos8FirmwareApproved(ap, '8.10.0.10', [])).toBe(true);
    const md = mapAos8Switch(SWITCH_ROW)!;
    expect(aos8FirmwareApproved(md, null, [])).toBe(true); // no train declared
  });

  it('honours an operator-declared approved-firmware map on top', () => {
    const md = mapAos8Switch(SWITCH_ROW)!; // 8.10.0.10, model 7210
    expect(aos8FirmwareApproved(md, '8.10.0.10', [['7210', '8.11']])).toBe(false);
    expect(aos8FirmwareApproved(md, '8.10.0.10', [['7210', '8.10']])).toBe(true);
  });
});

describe('mapAos8Client', () => {
  it('maps a wireless user off the global user table', () => {
    expect(mapAos8Client(USER_ROW)).toMatchObject({
      name: 'k.ortega',
      mac: '9c:3e:53:aa:01:22',
      ip: '10.44.12.31',
      medium: 'wireless',
      type: 'laptop',
      plane: 'AOS-8',
      planeTone: 'accent',
      siteId: 'multiple',
      role: 'clinical-staff',
      auth: '802.1x',
      group: 'clinical-aaa',
      attach: 'ap-t1-12',
      where: 'MERIDIAN-CLIN/9c:3e:53:aa:0f:10/6GHz',
      session: '00:04:12',
    });
  });

  it('reads a user with no ESSID as wired and asserts nothing the MM did not say', () => {
    const c = mapAos8Client(USER_ROW_WIRED);
    expect(c).toMatchObject({ medium: 'wired', health: '—', quality: null, problem: false, rssi: '—' });
    expect(c?.where).toBe('—');
  });

  it('drops a row without a MAC', () => {
    expect(mapAos8Client({ IP: '10.44.0.9', Role: 'guest' })).toBeNull();
    expect(mapAos8Client(null)).toBeNull();
  });
});

// -- pull() end-to-end -------------------------------------------------------------

describe('Aos8Adapter.pull', () => {
  it('logs in, pulls every table and keeps secrets out of the call log', async () => {
    const seen = seenLog();
    const { adapter, calls, st } = makeAdapter(fakeFetch({ seen }));
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(3);
    expect(pull.devices?.[0]).toMatchObject({ name: 'ap-t1-12', type: 'ap', state: 'up' });
    expect(pull.devices?.[2]).toMatchObject({ name: 'mc-lake-2', type: 'controller' });
    // README integration table: the AOS-8 plane reads clients, not just inventory.
    expect(pull.clients).toHaveLength(2);
    expect(pull.clients?.[0]).toMatchObject({ name: 'k.ortega', plane: 'AOS-8', medium: 'wireless' });
    // Login carried the credentials; showcommand carried the UID, redacted in the log.
    expect(seen.loginBodies[0]).toContain('username=portal-read');
    expect(seen.loginBodies[0]).toContain('password=s3cret');
    expect(seen.urls.some((u) => u.includes('UIDARUBA=uid-abc-123'))).toBe(true);
    expect(calls.every((c) => !c.path.includes('uid-abc-123') && !c.path.includes('s3cret'))).toBe(true);
    expect(st.note).toContain('2 APs · 1 controllers via showcommand');
    expect(st.note).toContain('1 down');
    expect(st.note).toContain('2 clients');
    expect(st.health).toBe('healthy');
  });

  // The MM authenticates /v1/configuration/* with BOTH halves: the SESSION
  // cookie minted at login and the UIDARUBA parameter.
  it('sends the SESSION cookie from the login answer on every showcommand', async () => {
    const seen = seenLog();
    const { adapter } = makeAdapter(fakeFetch({ seen, loginSetCookie: 'SESSION=sess-xyz-789; Path=/; HttpOnly' }));
    await adapter.pull();
    expect(seen.cookies.length).toBeGreaterThan(0);
    expect(seen.cookies.every((c) => c === 'SESSION=sess-xyz-789')).toBe(true);
  });

  it('falls back to SESSION=<uid> when the master sends no readable cookie', async () => {
    const seen = seenLog();
    const { adapter } = makeAdapter(fakeFetch({ seen }));
    await adapter.pull();
    expect(seen.cookies.every((c) => c === 'SESSION=uid-abc-123')).toBe(true);
  });

  it('caches the session across the sections (one login per pull)', async () => {
    const seen = seenLog();
    const { adapter } = makeAdapter(fakeFetch({ seen }));
    await adapter.pull();
    expect(seen.loginBodies).toHaveLength(1);
  });

  it('re-logs in once when the MM answers status != 0', async () => {
    const seen = seenLog();
    const { adapter } = makeAdapter(
      fakeFetch({
        seen,
        apBodies: [
          { status: 200, body: { _global_result: { status: '1', status_str: 'Session expired' } } },
          { status: 200, body: apDatabaseBody([AP_UP]) },
        ],
      }),
    );
    const pull = await adapter.pull();
    expect(pull.devices?.some((d) => d.name === 'ap-t1-12')).toBe(true);
    expect(seen.loginBodies).toHaveLength(2);
  });

  // 401/403 is the MM saying the session is gone, not that the pull is dead.
  it('treats a 401 as session expiry and retries after one re-login', async () => {
    const seen = seenLog();
    const { adapter } = makeAdapter(
      fakeFetch({
        seen,
        apBodies: [
          { status: 401, body: {} },
          { status: 200, body: apDatabaseBody([AP_UP]) },
        ],
      }),
    );
    const pull = await adapter.pull();
    expect(pull.devices?.some((d) => d.name === 'ap-t1-12')).toBe(true);
    expect(seen.loginBodies).toHaveLength(2);
  });

  it('fails naming the section when the 401 survives the re-login', async () => {
    const { adapter } = makeAdapter(fakeFetch({ apBodies: [{ status: 403, body: {} }] }));
    await expect(adapter.pull()).rejects.toThrow(
      "section 'show ap database long' failed — HTTP 403 from showcommand 'show ap database long' after re-login",
    );
  });

  // An unauthenticated MM answers a /v1/configuration GET with the WebUI login
  // HTML at HTTP 200 — that must fail the pull, not become an empty inventory.
  it('refuses a non-JSON showcommand body instead of publishing zero devices', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({ apRaw: [{ status: 200, text: '<html><body>Aruba login</body></html>' }] }),
    );
    await expect(adapter.pull()).rejects.toThrow(/non-JSON body from showcommand 'show ap database long'/);
    expect(st.health).not.toBe('healthy');
  });

  it('refuses to publish an empty inventory as a good sync', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({
        apBodies: [{ status: 200, body: apDatabaseBody([]) }],
        switchBodies: [{ status: 200, body: switchesBody([]) }],
      }),
    );
    await expect(adapter.pull()).rejects.toThrow(/refusing to publish an empty inventory as current/);
    expect(st.health).not.toBe('healthy');
  });

  // Clients are additive: losing them must not lose the inventory, but the
  // gap is named rather than silently reported as "no clients".
  it('keeps the inventory when the client table fails, and says so in the note', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ userBodies: [{ status: 500, body: {} }] }));
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(3);
    expect(pull.clients).toBeUndefined();
    expect(st.note).toContain('client table unavailable');
    expect(st.note).toContain("section 'show global-user-table list' failed");
    /* And declared, not just described. partial[] is the contract that holds
       the plane at 'warning' in markSyncResult and keeps the dataset out of
       lastSyncFor; the note is prose on one screen. Without this a controller
       whose client table had been refusing for hours wore a green badge —
       every other plane here declares its unread datasets this way (see
       mist.test.ts's markSyncResult('mist', true, { partial: ['clients'] })). */
    expect(pull.partial).toEqual(['clients']);
  });

  it('declares nothing partial when every section answered', async () => {
    const { adapter } = makeAdapter(fakeFetch({}));
    const pull = await adapter.pull();
    expect(pull.clients).toHaveLength(2);
    expect(pull.partial).toBeUndefined();
  });

  // AOS-8 requires every MD to run the master's train, so the master's own
  // version IS the approved one — without this no AOS-8 row could ever render
  // amber, however far out of step the estate was.
  it('flags a controller off the master train and names the skew in the note', async () => {
    const master = { Name: 'mm-lake-1', 'IP Address': '10.48.0.10', Type: 'master', Version: '8.10.0.10', Status: 'up' };
    const skewed = { ...SWITCH_ROW, Name: 'mc-lake-3', Version: '8.10.0.9' };
    const { adapter, st } = makeAdapter(
      fakeFetch({ switchBodies: [{ status: 200, body: switchesBody([master, SWITCH_ROW, skewed]) }] }),
    );
    const pull = await adapter.pull();
    const byName = new Map(pull.devices!.map((d) => [d.name, d]));
    expect(byName.get('mm-lake-1')?.firmwareApproved).toBe(true);
    expect(byName.get('mc-lake-2')?.firmwareApproved).toBe(true);
    expect(byName.get('mc-lake-3')?.firmwareApproved).toBe(false);
    expect(st.note).toContain('1 off the 8.10.0.10 train');
  });

  // The MM caps concurrent management sessions: abandoning a UID on every
  // 14-minute rollover eventually earns 'maximum number of sessions reached'.
  it('hands the old UID back before minting a new session', async () => {
    const seen = seenLog();
    const { adapter, calls } = makeAdapter(fakeFetch({ seen }));
    await adapter.pull();
    expect(seen.urls.some((u) => u.includes('/v1/api/logout'))).toBe(false); // nothing to release yet
    // force the rollover the MM's 15-minute session lifetime causes
    (adapter as unknown as { session: { expiresAt: number } | null }).session!.expiresAt = Date.now() - 1;
    await adapter.pull();
    expect(seen.urls.some((u) => u.includes('/v1/api/logout?UIDARUBA=uid-abc-123'))).toBe(true);
    // recorded like any other call, with the UID redacted out of the log
    const logoutCalls = calls.filter((c) => c.path.startsWith('POST /v1/api/logout'));
    expect(logoutCalls).toHaveLength(1);
    expect(logoutCalls[0].path).not.toContain('uid-abc-123');
  });

  // A replaced adapter never rolls its session over again, so the credential
  // save that replaced it would otherwise leak the UID until the MM's idle
  // timer reaps it (registry.reinitPlane calls dispose() on the outgoing one).
  it('dispose() hands the live UID back and is safe to call twice', async () => {
    const seen = seenLog();
    const { adapter, calls } = makeAdapter(fakeFetch({ seen }));
    await adapter.pull();
    expect(seen.urls.some((u) => u.includes('/v1/api/logout'))).toBe(false);
    await adapter.dispose();
    expect(seen.urls.some((u) => u.includes('/v1/api/logout?UIDARUBA=uid-abc-123'))).toBe(true);
    expect(calls.filter((c) => c.path.startsWith('POST /v1/api/logout'))).toHaveLength(1);
    // No session left to release — a second dispose() sends nothing.
    await adapter.dispose();
    expect(calls.filter((c) => c.path.startsWith('POST /v1/api/logout'))).toHaveLength(1);
  });

  it('dispose() never throws when the master is unreachable', async () => {
    const base = fakeFetch({});
    const { adapter } = makeAdapter(async (url, init) => {
      if (String(url).includes('/v1/api/logout')) throw new Error('connection reset');
      return base(url, init);
    });
    await adapter.pull();
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });

  it('never lets a failing logout break the pull', async () => {
    const base = fakeFetch({});
    const { adapter } = makeAdapter(async (url, init) => {
      if (String(url).includes('/v1/api/logout')) throw new Error('connection reset');
      return base(url, init);
    });
    await adapter.pull();
    (adapter as unknown as { session: { expiresAt: number } | null }).session!.expiresAt = Date.now() - 1;
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(3);
  });

  // The one plane the portal can give a shell to (README: recorded SSH,
  // change window only) — configuration still stays on the MM.
  it('claims a local shell, but no brokered write and no config read', () => {
    const { adapter } = makeAdapter(fakeFetch({}));
    expect(adapter.capabilities()).toEqual({ localShell: true, brokeredWrite: false, configRead: false });
  });

  it('fails the pull naming the section when login is rejected', async () => {
    const { adapter } = makeAdapter(fakeFetch({ loginStatus: 401 }));
    await expect(adapter.pull()).rejects.toThrow("section 'show ap database long' failed — login failed: HTTP 401");
  });

  it('fails the pull naming the section when a showcommand errors', async () => {
    const { adapter } = makeAdapter(fakeFetch({ switchBodies: [{ status: 500, body: {} }] }));
    await expect(adapter.pull()).rejects.toThrow("section 'show switches' failed");
  });

  it('rejects an http:// master — the login would carry the password in cleartext', () => {
    expect(
      () => new Aos8Adapter({ ...CREDS, master: 'http://10.48.0.10:4343' }, state(), () => {}, fakeFetch({})),
    ).toThrow(/must use https/);
    expect(
      () => new Aos8Adapter({ ...CREDS, master: 'ftp://10.48.0.10' }, state(), () => {}, fakeFetch({})),
    ).toThrow(/must use https/);
    // https (explicit or defaulted) still constructs fine
    expect(new Aos8Adapter({ ...CREDS, master: 'https://10.48.0.10:4343' }, state(), () => {}, fakeFetch({}))).toBeInstanceOf(Aos8Adapter);
  });

  it('isComplete needs master plus username/password (clientId/clientSecret accepted)', () => {
    expect(Aos8Adapter.isComplete(CREDS)).toBe(true);
    expect(Aos8Adapter.isComplete({ master: 'mm:4343', clientId: 'u', clientSecret: 'p' })).toBe(true);
    expect(Aos8Adapter.isComplete({ master: 'mm:4343', username: 'u' })).toBe(false);
    expect(Aos8Adapter.isComplete({ username: 'u', password: 'p' })).toBe(false);
    expect(Aos8Adapter.isComplete(null)).toBe(false);
  });
});
