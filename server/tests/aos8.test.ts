/**
 * server/tests/aos8.test.ts — AOS-8 adapter unit tests, NO network.
 *
 * The mapping helpers are tested against AOS-8-style showcommand tables
 * inlined here; Aos8Adapter.pull() is exercised end-to-end with an in-memory
 * fake `fetch` (FetchLike injection) to cover the UIDARUBA login flow, session
 * caching + re-login on status != "0", table extraction across body shapes,
 * section-named failures, and the redacted call log (no UID, no password).
 */

import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { FetchLike } from '../src/planes/aos8';
import { Aos8Adapter, mapAos8Ap, mapAos8Switch } from '../src/planes/aos8';

// -- Recorded fixtures (shapes as the MM API returns them) ----------------------

const AP_UP = { Name: 'ap-t1-12', Group: 'lake-tower', 'AP Type': 'AP-535', 'IP Address': '10.48.1.42', Status: 'Up 9d:02:14:03' };
const AP_DOWN = { Name: 'ap-t1-19', Group: 'lake-tower', 'AP Type': 'AP-535', 'IP Address': '10.48.1.57', Status: 'Down' };
const SWITCH_ROW = { Name: 'mc-lake-2', 'IP Address': '10.48.0.12', Model: '7210', Version: '8.10.0.10', Status: 'up', Type: 'MD' };

const LOGIN_OK = { _global_result: { status: '0', status_str: 'Login successful', UIDARUBA: 'uid-abc-123' } };

function apDatabaseBody(aps: unknown[]): unknown {
  return { _global_result: { status: '0' }, 'AP Database': aps };
}
function switchesBody(switches: unknown[]): unknown {
  return { _global_result: { status: '0' }, _data: { Switches: switches } }; // nested variant
}

function state(): PlaneState {
  return { id: 'aos8', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { master: '10.48.0.10:4343', username: 'portal-read', password: 's3cret' };

/** Fake fetch answering the login POST and the two showcommand GETs. */
function fakeFetch(opts: {
  loginStatus?: number;
  loginBodies?: unknown[];
  apBodies?: Array<{ status: number; body: unknown }>;
  switchBodies?: Array<{ status: number; body: unknown }>;
  seen?: { urls: string[]; loginBodies: string[] };
}): FetchLike {
  const apBodies = opts.apBodies ?? [{ status: 200, body: apDatabaseBody([AP_UP, AP_DOWN]) }];
  const switchBodies = opts.switchBodies ?? [{ status: 200, body: switchesBody([SWITCH_ROW]) }];
  const loginBodies = opts.loginBodies ?? [LOGIN_OK];
  let loginIdx = 0;
  let apIdx = 0;
  let swIdx = 0;
  return async (url, init) => {
    const u = String(url);
    if (opts.seen) {
      opts.seen.urls.push(u);
      if (u.includes('/v1/api/login') && typeof init?.body === 'string') opts.seen.loginBodies.push(init.body);
    }
    if (u.includes('/v1/api/login')) {
      const status = opts.loginStatus ?? 200;
      const body = loginBodies[Math.min(loginIdx, loginBodies.length - 1)];
      loginIdx += 1;
      return new Response(JSON.stringify(body), { status });
    }
    if (u.includes('showcommand') && u.includes(encodeURIComponent('show ap database long'))) {
      const b = apBodies[Math.min(apIdx, apBodies.length - 1)];
      apIdx += 1;
      return new Response(JSON.stringify(b.body), { status: b.status });
    }
    if (u.includes('showcommand') && u.includes(encodeURIComponent('show switches'))) {
      const b = switchBodies[Math.min(swIdx, switchBodies.length - 1)];
      swIdx += 1;
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
      siteId: 'multiple',
      localShell: false,
    });
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
});

// -- pull() end-to-end -------------------------------------------------------------

describe('Aos8Adapter.pull', () => {
  it('logs in, pulls both tables and keeps secrets out of the call log', async () => {
    const seen = { urls: [] as string[], loginBodies: [] as string[] };
    const { adapter, calls, st } = makeAdapter(fakeFetch({ seen }));
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(3);
    expect(pull.devices?.[0]).toMatchObject({ name: 'ap-t1-12', type: 'ap', state: 'up' });
    expect(pull.devices?.[2]).toMatchObject({ name: 'mc-lake-2', type: 'controller' });
    // Login carried the credentials; showcommand carried the UID, redacted in the log.
    expect(seen.loginBodies[0]).toContain('username=portal-read');
    expect(seen.loginBodies[0]).toContain('password=s3cret');
    expect(seen.urls.some((u) => u.includes('UIDARUBA=uid-abc-123'))).toBe(true);
    expect(calls.every((c) => !c.path.includes('uid-abc-123') && !c.path.includes('s3cret'))).toBe(true);
    expect(st.note).toContain('2 APs · 1 controllers via showcommand');
    expect(st.note).toContain('1 down');
    expect(st.health).toBe('healthy');
  });

  it('caches the session across the two sections (one login per pull)', async () => {
    const seen = { urls: [] as string[], loginBodies: [] as string[] };
    const { adapter } = makeAdapter(fakeFetch({ seen }));
    await adapter.pull();
    expect(seen.loginBodies).toHaveLength(1);
  });

  it('re-logs in once when the MM answers status != 0', async () => {
    const seen = { urls: [] as string[], loginBodies: [] as string[] };
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
