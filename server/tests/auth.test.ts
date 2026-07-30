/**
 * server/tests/auth.test.ts — OIDC sign-in, end to end.
 *
 * The interesting half of this file is not the unit tests, it is the mock
 * identity provider: a real HTTP server on an ephemeral port serving a real
 * discovery document and a real JWKS, signing real RS256 ID tokens with a
 * generated key. The portal's login flow runs against it unmodified — same
 * discovery, same PKCE, same signature verification, same nonce check.
 *
 * That matters because every interesting failure mode here (a token signed by
 * the wrong key, a replayed nonce, a state that came from another browser) is
 * invisible to a test that stubs the verification step. Those are exactly the
 * cases asserted below.
 *
 * HPE_SETTINGS_PATH points at a fresh tmp dir before any server module is
 * imported, so nothing here touches the real data/settings.json.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { DEFAULT_VLAN_FORM } from '@hpe/shared';

let tmpDir: string;
let idp: Server;
let issuer: string;
let portal: Server;
let portalBase: string;

let privateKey: KeyLike;
let publicJwk: JWK;
/** A second key the provider never publishes — used to forge a bad token. */
let rogueKey: KeyLike;

const CLIENT_ID = 'hpe-network-tools';
const CLIENT_SECRET = 'top-secret-value';

/** Set by the test from the authorize redirect; the mock signs it into the token. */
let nonceForNextToken = '';
/** Claims the mock puts in the next ID token. */
let claimsForNextToken: Record<string, unknown> = {};
/** When set, the mock signs with the unpublished key instead. */
let signWithRogueKey = false;
/** Captured token-endpoint form bodies, for asserting PKCE and client auth. */
let tokenRequests: { body: URLSearchParams; auth: string | undefined }[] = [];

type Mod = typeof import('../src/services/auth');
let auth: Mod;
let settingsMod: typeof import('../src/config/settings');

async function signIdToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ nonce: nonceForNextToken, ...claimsForNextToken })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setAudience(CLIENT_ID)
    .setSubject((claimsForNextToken.sub as string) ?? 'user-1')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signWithRogueKey ? rogueKey : privateKey);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-auth-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');

  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  rogueKey = (await generateKeyPair('RS256')).privateKey;

  // --- mock identity provider ---------------------------------------------
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          scopes_supported: ['openid', 'profile', 'email', 'groups'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        }),
      );
      return;
    }
    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        tokenRequests.push({
          body: new URLSearchParams(raw),
          auth: req.headers.authorization,
        });
        void signIdToken().then((idToken) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'at', token_type: 'Bearer', id_token: idToken }));
        });
      });
      return;
    }
    res.writeHead(404).end('no');
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  // --- portal --------------------------------------------------------------
  auth = await import('../src/services/auth');
  settingsMod = await import('../src/config/settings');
  const { createApp } = await import('../src/index');

  settingsMod.settings.load();
  settingsMod.settings.update({
    demoMode: true,
    auth: {
      issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: 'http://127.0.0.1:5173/api/auth/callback',
    },
  });

  const app = createApp({ auth: auth.requireAuth() });
  portal = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => portal.once('listening', r));
  portalBase = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => portal.close(() => r()));
  await new Promise<void>((r) => idp.close(() => r()));
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  nonceForNextToken = '';
  claimsForNextToken = {};
  signWithRogueKey = false;
  tokenRequests = [];
  auth.resetDiscoveryCache();
});

/** Pull one cookie's value out of a Set-Cookie list. */
function cookieValue(setCookie: string[], name: string): string | null {
  for (const line of setCookie) {
    const m = line.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/**
 * Drive a full sign-in and return the session cookie value.
 * Mirrors exactly what a browser does, including carrying the state cookie.
 */
async function signIn(
  claims: Record<string, unknown> = { preferred_username: 'alice', email: 'alice@example.com' },
): Promise<{ sessionId: string | null; callback: Response }> {
  const login = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
  const stateCookie = cookieValue(login.headers.getSetCookie(), auth.STATE_COOKIE);
  const authorizeUrl = new URL(login.headers.get('location')!);
  const state = authorizeUrl.searchParams.get('state')!;
  nonceForNextToken = authorizeUrl.searchParams.get('nonce')!;
  claimsForNextToken = claims;

  const callback = await fetch(
    `${portalBase}/api/auth/callback?code=abc123&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: { cookie: `${auth.STATE_COOKIE}=${encodeURIComponent(stateCookie ?? '')}` } },
  );
  return { sessionId: cookieValue(callback.headers.getSetCookie(), auth.SESSION_COOKIE), callback };
}

describe('cookie handling', () => {
  it('parses a cookie header and ignores malformed pairs', () => {
    const out = auth.parseCookies('a=1; b=two%20words; ; =nokey; c');
    expect(out).toEqual({ a: '1', b: 'two words' });
  });

  it('always marks the session cookie HttpOnly and SameSite', () => {
    const c = auth.serializeCookie('hpe_sid', 'v', { secure: true, maxAgeMs: 1000 });
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Secure');
    expect(c).toContain('Max-Age=1');
  });

  it('omits Secure on loopback, because the browser would drop the cookie', () => {
    const req = { secure: false, headers: { host: '127.0.0.1:5173' } } as never;
    expect(auth.needsSecureCookie(req)).toBe(false);
  });

  it('requires Secure as soon as the host is not loopback', () => {
    const req = { secure: false, headers: { host: 'portal.example.com' } } as never;
    expect(auth.needsSecureCookie(req)).toBe(true);
  });
});

describe('issuer validation', () => {
  it('accepts https', () => {
    expect(auth.validateIssuer('https://id.securessid.com/application/o/x/').ok).toBe(true);
  });

  it('accepts http only on loopback, where there is no network to sniff', () => {
    expect(auth.validateIssuer('http://127.0.0.1:9000').ok).toBe(true);
    const off = auth.validateIssuer('http://id.securessid.com');
    expect(off.ok).toBe(false);
    expect(off.ok === false && off.reason).toMatch(/HTTPS/);
  });

  it('rejects an issuer with embedded credentials', () => {
    const r = auth.validateIssuer('https://user:pw@id.example.com');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/credentials/);
  });

  it('allows a private LAN issuer, unlike the webhook SSRF rule', () => {
    // A self-hosted Authentik on the LAN is the expected deployment; the
    // webhook validator would reject this and must not be reused here.
    expect(auth.validateIssuer('https://10.0.0.5/application/o/x/').ok).toBe(true);
  });
});

describe('return-to handling', () => {
  it('keeps an in-app path', () => {
    expect(auth.safeReturnTo('/systems?tab=central')).toBe('/systems?tab=central');
  });

  it('refuses anything that could leave the site', () => {
    expect(auth.safeReturnTo('https://evil.test/x')).toBe('/');
    expect(auth.safeReturnTo('//evil.test/x')).toBe('/');
    expect(auth.safeReturnTo('javascript:alert(1)')).toBe('/');
    expect(auth.safeReturnTo(undefined)).toBe('/');
  });
});

describe('group gate', () => {
  const cfg = { issuer: 'i', clientId: 'c', clientSecret: 's', redirectUri: 'r' };
  const alice = { sub: 'u1', name: 'alice', email: null, groups: ['netops'] };

  it('permits everyone when no groups are configured', () => {
    expect(auth.isPermitted(alice, cfg)).toBe(true);
    expect(auth.isPermitted(alice, { ...cfg, allowedGroups: [] })).toBe(true);
  });

  it('permits a member and refuses a non-member', () => {
    expect(auth.isPermitted(alice, { ...cfg, allowedGroups: ['netops'] })).toBe(true);
    expect(auth.isPermitted(alice, { ...cfg, allowedGroups: ['admins'] })).toBe(false);
  });
});

describe('open paths', () => {
  it('matches whether or not the /api prefix was stripped by the mount', () => {
    expect(auth.isOpenPath('/api/auth/login')).toBe(true);
    expect(auth.isOpenPath('/auth/login')).toBe(true);
    expect(auth.isOpenPath('/api/health')).toBe(true);
    expect(auth.isOpenPath('/health')).toBe(true);
  });

  it('does not open anything else', () => {
    expect(auth.isOpenPath('/api/systems')).toBe(false);
    expect(auth.isOpenPath('/api/terminal/sessions')).toBe(false);
    expect(auth.isOpenPath('/api/auth/logi')).toBe(false);
  });
});

describe('discovery', () => {
  it('reads the provider document', async () => {
    const meta = await auth.discover(issuer);
    expect(meta.token_endpoint).toBe(`${issuer}/token`);
    expect(meta.jwks_uri).toBe(`${issuer}/jwks`);
  });

  it('refuses a document that claims a different issuer than the one configured', async () => {
    // Guards against a compromised or misconfigured discovery endpoint
    // redirecting verification at a issuer the operator never approved.
    const rogue = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: 'https://attacker.example',
          authorization_endpoint: 'https://attacker.example/a',
          token_endpoint: 'https://attacker.example/t',
          jwks_uri: 'https://attacker.example/j',
        }),
      );
    });
    await new Promise<void>((r) => rogue.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(rogue.address() as AddressInfo).port}`;
    await expect(auth.discover(base)).rejects.toThrow(/does not match the configured/);
    await new Promise<void>((r) => rogue.close(() => r()));
  });
});

describe('login redirect', () => {
  it('sends the operator to the provider with PKCE, state and nonce', async () => {
    const res = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    // groups is advertised by this provider, so it is requested.
    expect(url.searchParams.get('scope')).toContain('groups');
  });

  it('binds the state to a cookie so the callback must land in the same browser', async () => {
    const res = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
    const state = new URL(res.headers.get('location')!).searchParams.get('state');
    const cookie = cookieValue(res.headers.getSetCookie(), auth.STATE_COOKIE);
    expect(cookie).toBe(state);
    expect(res.headers.getSetCookie().join()).toContain('HttpOnly');
  });

  it('never puts the client secret in the redirect', async () => {
    const res = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
    expect(res.headers.get('location')).not.toContain(CLIENT_SECRET);
  });
});

describe('callback', () => {
  it('completes a sign-in and issues a session cookie', async () => {
    const { sessionId, callback } = await signIn();
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/');
    expect(sessionId).toBeTruthy();
  });

  it('sends the PKCE verifier that matches the challenge it advertised', async () => {
    const login = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
    const stateCookie = cookieValue(login.headers.getSetCookie(), auth.STATE_COOKIE);
    const url = new URL(login.headers.get('location')!);
    const challenge = url.searchParams.get('code_challenge')!;
    nonceForNextToken = url.searchParams.get('nonce')!;
    claimsForNextToken = { preferred_username: 'alice' };

    await fetch(`${portalBase}/api/auth/callback?code=c&state=${encodeURIComponent(url.searchParams.get('state')!)}`, {
      redirect: 'manual',
      headers: { cookie: `${auth.STATE_COOKIE}=${encodeURIComponent(stateCookie!)}` },
    });

    const verifier = tokenRequests[0].body.get('code_verifier')!;
    const recomputed = createHash('sha256').update(verifier).digest('base64url');
    expect(recomputed).toBe(challenge);
    expect(tokenRequests[0].body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(tokenRequests[0].body.get('grant_type')).toBe('authorization_code');
  });

  it('refuses a callback whose state cookie is missing (login CSRF)', async () => {
    const login = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    // No cookie header: the flow started in someone else's browser.
    const res = await fetch(`${portalBase}/api/auth/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/did not start in this browser/);
    expect(cookieValue(res.headers.getSetCookie(), auth.SESSION_COOKIE)).toBeNull();
  });

  it('refuses a callback whose state cookie belongs to a different flow', async () => {
    const a = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
    const b = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
    const stateA = new URL(a.headers.get('location')!).searchParams.get('state')!;
    const cookieB = cookieValue(b.headers.getSetCookie(), auth.STATE_COOKIE)!;
    const res = await fetch(`${portalBase}/api/auth/callback?code=c&state=${encodeURIComponent(stateA)}`, {
      redirect: 'manual',
      headers: { cookie: `${auth.STATE_COOKIE}=${encodeURIComponent(cookieB)}` },
    });
    expect(res.status).toBe(400);
    expect(cookieValue(res.headers.getSetCookie(), auth.SESSION_COOKIE)).toBeNull();
  });

  it('refuses to reuse a state a second time', async () => {
    const login = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
    const stateCookie = cookieValue(login.headers.getSetCookie(), auth.STATE_COOKIE)!;
    const url = new URL(login.headers.get('location')!);
    const state = url.searchParams.get('state')!;
    nonceForNextToken = url.searchParams.get('nonce')!;
    const headers = { cookie: `${auth.STATE_COOKIE}=${encodeURIComponent(stateCookie)}` };
    const first = await fetch(`${portalBase}/api/auth/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers,
    });
    expect(first.status).toBe(302);
    const second = await fetch(`${portalBase}/api/auth/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers,
    });
    expect(second.status).toBe(400);
    expect(await second.text()).toMatch(/expired/);
  });

  it('rejects a token signed by a key the provider does not publish', async () => {
    signWithRogueKey = true;
    const { sessionId, callback } = await signIn();
    expect(callback.status).toBe(401);
    expect(sessionId).toBeNull();
  });

  it('rejects a token whose nonce is not the one this login asked for', async () => {
    const login = await fetch(`${portalBase}/api/auth/login`, { redirect: 'manual' });
    const stateCookie = cookieValue(login.headers.getSetCookie(), auth.STATE_COOKIE)!;
    const url = new URL(login.headers.get('location')!);
    nonceForNextToken = 'a-nonce-from-some-earlier-login';
    const res = await fetch(
      `${portalBase}/api/auth/callback?code=c&state=${encodeURIComponent(url.searchParams.get('state')!)}`,
      { redirect: 'manual', headers: { cookie: `${auth.STATE_COOKIE}=${encodeURIComponent(stateCookie)}` } },
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/nonce/);
    expect(cookieValue(res.headers.getSetCookie(), auth.SESSION_COOKIE)).toBeNull();
  });

  it('reports a provider-side refusal as a refusal, not a portal fault', async () => {
    const res = await fetch(`${portalBase}/api/auth/callback?error=access_denied`, { redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/refused the sign-in/);
  });

  it('never echoes the provider error code back to the browser', async () => {
    const res = await fetch(`${portalBase}/api/auth/callback?error=some_internal_detail`, { redirect: 'manual' });
    expect(await res.text()).not.toContain('some_internal_detail');
  });
});

describe('group enforcement at sign-in', () => {
  afterAll(() => {
    settingsMod.settings.update({ auth: { ...settingsMod.settings.get().auth!, allowedGroups: [] } });
  });

  it('refuses a verified identity that is in no permitted group', async () => {
    settingsMod.settings.update({
      auth: { ...settingsMod.settings.get().auth!, allowedGroups: ['net-admins'] },
    });
    const { sessionId, callback } = await signIn({ preferred_username: 'bob', groups: ['interns'] });
    expect(callback.status).toBe(403);
    expect(await callback.text()).toMatch(/not permitted/);
    expect(sessionId).toBeNull();
  });

  it('admits a verified identity that is in a permitted group', async () => {
    settingsMod.settings.update({
      auth: { ...settingsMod.settings.get().auth!, allowedGroups: ['net-admins'] },
    });
    const { sessionId, callback } = await signIn({ preferred_username: 'carol', groups: ['net-admins'] });
    expect(callback.status).toBe(302);
    expect(sessionId).toBeTruthy();
  });
});

describe('the guard', () => {
  it('refuses an API route without a session', async () => {
    const res = await fetch(`${portalBase}/api/systems`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'authentication required', login: '/api/auth/login' });
  });

  it('refuses recorded shell transcripts without a session', async () => {
    // These carry raw switch output; they were previously served to anyone.
    const res = await fetch(`${portalBase}/api/terminal/sessions`);
    expect(res.status).toBe(401);
  });

  it('allows the route once signed in', async () => {
    const { sessionId } = await signIn();
    const res = await fetch(`${portalBase}/api/systems`, {
      headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(sessionId!)}` },
    });
    expect(res.status).toBe(200);
  });

  it('leaves health open so a probe does not need credentials', async () => {
    const res = await fetch(`${portalBase}/api/health`);
    expect(res.status).toBe(200);
  });

  it('refuses a forged session id', async () => {
    const res = await fetch(`${portalBase}/api/systems`, {
      headers: { cookie: `${auth.SESSION_COOKIE}=not-a-real-session` },
    });
    expect(res.status).toBe(401);
  });
});

describe('/api/auth/me', () => {
  it('distinguishes not-signed-in from not-configured', async () => {
    const res = await fetch(`${portalBase}/api/auth/me`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, authenticated: false, principal: null });
  });

  it('names the signed-in principal', async () => {
    const { sessionId } = await signIn({ preferred_username: 'dave', email: 'dave@example.com', groups: ['netops'] });
    const res = await fetch(`${portalBase}/api/auth/me`, {
      headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(sessionId!)}` },
    });
    const body = (await res.json()) as { authenticated: boolean; principal: { name: string; email: string; groups: string[] } };
    expect(body.authenticated).toBe(true);
    expect(body.principal.name).toBe('dave');
    expect(body.principal.email).toBe('dave@example.com');
    expect(body.principal.groups).toEqual(['netops']);
  });

  it('never exposes the client secret', async () => {
    const res = await fetch(`${portalBase}/api/auth/me`);
    expect(await res.text()).not.toContain(CLIENT_SECRET);
  });
});

describe('logout', () => {
  it('drops the session so the cookie stops working', async () => {
    const { sessionId } = await signIn();
    const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(sessionId!)}`;
    expect((await fetch(`${portalBase}/api/systems`, { headers: { cookie } })).status).toBe(200);

    const out = await fetch(`${portalBase}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().join()).toMatch(/hpe_sid=;.*Max-Age=0/);

    expect((await fetch(`${portalBase}/api/systems`, { headers: { cookie } })).status).toBe(401);
  });
});

describe('session store', () => {
  it('expires a session once its lifetime is up', () => {
    let now = 1_000_000;
    const store = new auth.SessionStore(() => now);
    const s = store.create({ sub: 'u', name: 'u', email: null, groups: [] });
    expect(store.get(s.id)).not.toBeNull();
    now += 13 * 60 * 60 * 1000;
    expect(store.get(s.id)).toBeNull();
  });

  it('abandons a login that was never completed', () => {
    let now = 1_000_000;
    const store = new auth.SessionStore(() => now);
    store.startLogin('st', { codeVerifier: 'v', nonce: 'n', returnTo: '/' });
    now += 11 * 60 * 1000;
    expect(store.takeLogin('st')).toBeNull();
  });

  it('issues session ids with real entropy and never reuses them', () => {
    const store = new auth.SessionStore();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      ids.add(store.create({ sub: 'u', name: 'u', email: null, groups: [] }).id);
    }
    expect(ids.size).toBe(200);
    expect([...ids][0].length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
  });
});

describe('cross-site request rejection', () => {
  it('refuses a POST from another site', async () => {
    const res = await fetch(`${portalBase}/api/auth/logout`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'cross-site requests are not accepted' });
  });

  it('accepts a POST from the portal itself', async () => {
    const res = await fetch(`${portalBase}/api/auth/logout`, {
      method: 'POST',
      headers: { origin: portalBase },
    });
    expect(res.status).toBe(200);
  });

  it('accepts a POST with no Origin, which is not a browser', async () => {
    const res = await fetch(`${portalBase}/api/auth/logout`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('does not block reads, which carry no state change', async () => {
    const res = await fetch(`${portalBase}/api/health`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
  });

  it('falls back to Referer when Origin is absent', async () => {
    const res = await fetch(`${portalBase}/api/auth/logout`, {
      method: 'POST',
      headers: { referer: 'https://evil.example/some/page' },
    });
    expect(res.status).toBe(403);
  });

  it('guards a real state-changing route, not just logout', async () => {
    const { sessionId } = await signIn();
    const res = await fetch(`${portalBase}/api/settings`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/json',
        cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(sessionId!)}`,
      },
      body: JSON.stringify({ demoMode: false }),
    });
    expect(res.status).toBe(403);
    // and the setting is untouched
    expect(settingsMod.settings.get().demoMode).toBe(true);
  });
});

describe('origin predicate', () => {
  it('is the same rule the terminal upgrade uses', async () => {
    const { isAllowedTerminalOrigin } = await import('../src/services/terminal');
    expect(isAllowedTerminalOrigin).toBe(auth.isAllowedOrigin);
  });

  it('allows a configured remote origin', () => {
    expect(auth.isAllowedOrigin('https://portal.example', 'other:5173', 'https://portal.example')).toBe(true);
    expect(auth.isAllowedOrigin('https://evil.example', 'other:5173', 'https://portal.example')).toBe(false);
  });

  it('refuses an unparseable origin rather than falling through', () => {
    expect(auth.isAllowedOrigin('not-a-url', 'localhost:5173', '')).toBe(false);
  });
});

describe('audit attribution end to end', () => {
  it('records the signed-in principal in the change log, not "operator"', async () => {
    const { appendBrokerLog } = await import('../src/services/writeBroker');
    const { readFileSync } = await import('node:fs');
    const dir = join(tmpDir, 'audit-e2e');

    // Inside a request scope carrying an identity...
    auth.withActor('alice@example.com', () => {
      appendBrokerLog(dir, { ts: 'T', event: 'push', changeId: 'c1', ticket: 'NET-1', kind: 'vlan', result: 'applied' });
    });
    // ...and outside one.
    appendBrokerLog(dir, { ts: 'T', event: 'push', changeId: 'c2', ticket: 'NET-2', kind: 'vlan', result: 'applied' });

    const lines = readFileSync(join(dir, 'change-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].who).toBe('alice@example.com');
    // No identity available is reported as the anonymous operator, never omitted:
    // an audit trail with holes looks complete and is not.
    expect(lines[1].who).toBe('operator');
  });

  it('attributes a real brokered write to the signed-in principal', async () => {
    const { sessionId } = await signIn({ preferred_username: 'erin', email: 'erin@example.com' });
    const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(sessionId!)}`;
    const headers = { cookie, origin: portalBase, 'content-type': 'application/json' };

    const queued = await fetch(`${portalBase}/api/configure/queue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'vlan', form: { ...DEFAULT_VLAN_FORM, id: '931' }, ticket: 'NET-4188' }),
    });
    expect(queued.status).toBe(200);

    const history = await fetch(`${portalBase}/api/configure/history?limit=1`, { headers: { cookie } });
    const body = (await history.json()) as { events: { who?: string }[] };
    expect(body.events[0].who).toBe('erin@example.com');
  });
});

describe('actor attribution', () => {
  it('prefers the email, then the name', () => {
    expect(auth.actorFor({ principal: { sub: 'u', name: 'alice', email: 'a@x.io', groups: [] } })).toBe('a@x.io');
    expect(auth.actorFor({ principal: { sub: 'u', name: 'alice', email: null, groups: [] } })).toBe('alice');
  });

  it('falls back to the anonymous operator when SSO is not in play', () => {
    // The audit trail must keep saying something true rather than inventing a
    // name it cannot support.
    expect(auth.actorFor(undefined)).toBe('operator');
    expect(auth.actorFor({})).toBe('operator');
  });
});

describe('OIDC configuration from the environment', () => {
  const base = {
    HPE_OIDC_ISSUER: 'https://id.securessid.com/application/o/portal/',
    HPE_OIDC_CLIENT_ID: 'abc',
    HPE_OIDC_CLIENT_SECRET: 'shh',
    HPE_OIDC_REDIRECT_URI: 'https://portal.example.com/api/auth/callback',
  };

  function store() {
    const file = join(tmpDir, `env-auth-${Math.random().toString(36).slice(2)}.json`);
    const s = new settingsMod.SettingsStore(file);
    s.load();
    return { s, file };
  }

  it('says nothing when the environment says nothing', () => {
    expect(store().s.overlayEnvAuth({})).toBeNull();
  });

  it('reads a complete set', () => {
    const { s } = store();
    const applied = s.overlayEnvAuth({ ...base });
    expect(applied).toMatchObject({ issuer: base.HPE_OIDC_ISSUER, clientId: 'abc', clientSecret: 'shh' });
    expect(s.get().auth?.clientId).toBe('abc');
  });

  it('splits allowed groups', () => {
    const applied = store().s.overlayEnvAuth({ ...base, HPE_OIDC_ALLOWED_GROUPS: ' net-admins , noc ,' });
    expect(applied?.allowedGroups).toEqual(['net-admins', 'noc']);
  });

  it('omits the group gate entirely when the list is empty', () => {
    // An empty array would read as "no group may enter" to a naive check;
    // absent means "any authenticated account", which is what was asked for.
    expect(store().s.overlayEnvAuth({ ...base, HPE_OIDC_ALLOWED_GROUPS: ' , ' })?.allowedGroups).toBeUndefined();
  });

  it('refuses a half-filled set rather than silently falling back to the file', () => {
    // A typo'd variable name must be loud. Quietly using file config the
    // operator believed they had replaced is the failure mode worth breaking.
    const { s } = store();
    expect(() => s.overlayEnvAuth({ HPE_OIDC_ISSUER: base.HPE_OIDC_ISSUER })).toThrow(/incomplete OIDC/);
    expect(() => s.overlayEnvAuth({ ...base, HPE_OIDC_CLIENT_SECRET: '' })).toThrow(/incomplete OIDC/);
    expect(s.get().auth).toBeNull();
  });

  it('never writes the secret back to disk', () => {
    const { s, file } = store();
    const before = readFileSync(file, 'utf8');
    s.overlayEnvAuth({ ...base });
    const after = readFileSync(file, 'utf8');
    expect(after).toBe(before);
    expect(after).not.toContain('shh');
  });
});
