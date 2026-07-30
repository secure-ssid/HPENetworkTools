/**
 * server/src/routes/auth.ts — OIDC sign-in endpoints.
 *
 *   GET  /api/auth/me        who am I, and is SSO even configured
 *   GET  /api/auth/login     start the flow → 302 to the identity provider
 *   GET  /api/auth/callback  provider returns here → session cookie → 302 back
 *   POST /api/auth/logout    drop the session
 *   GET  /api/auth/config    the configured provider, secret masked
 *   POST /api/auth/test      prove the provider is reachable and the client real
 *   PUT  /api/auth/config    save it
 *   DELETE /api/auth/config  remove it
 *
 * The first four are reachable without a session (see OPEN_PATHS in
 * services/auth.ts) — guarding the login route would make login impossible,
 * and `me` has to be answerable before the client knows whether it is signed
 * in. The config routes are exported as a *separate* router so createApp can
 * mount them behind the guard; see createAuthConfigRouter for why that
 * separation is load-bearing rather than tidy.
 *
 * `me` deliberately distinguishes *not configured* from *not signed in*. They
 * look the same to an unauthenticated caller but they are opposite situations
 * for an operator: one means "set up your identity provider", the other means
 * "click sign in". Collapsing them would be the same class of dishonesty this
 * codebase refuses everywhere else — reporting an unread state as an empty one.
 *
 * Failures during the callback render a small HTML page rather than JSON: the
 * browser navigated here, so a raw JSON body would be shown as text with no
 * way back. The page never echoes provider error detail (it can contain the
 * authorization code); that stays in the server log.
 */

import { Router, type Response } from 'express';
import * as crypto from 'node:crypto';
import { MASK, SettingsConflictError, isMasked, settings, type AuthSettings } from '../config/settings';
import { h } from './handler';
import {
  AuthError,
  SESSION_COOKIE,
  STATE_COOKIE,
  buildAuthorizeUrl,
  createPkcePair,
  discover,
  exchangeCode,
  isAuthGuardInstalled,
  isPermitted,
  needsSecureCookie,
  parseCookies,
  resetDiscoveryCache,
  safeReturnTo,
  serializeCookie,
  sessionStore,
  validateIssuer,
  verifyIdToken,
  type SessionStore,
} from '../services/auth';

/** Minimal HTML for a browser-facing failure. Escaped; never echoes provider text. */
function errorPage(res: Response, status: number, heading: string, detail: string): void {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>` +
        `<body style="font:14px system-ui;margin:3rem auto;max-width:34rem;color:#111">` +
        `<h1 style="font-size:1.15rem">${esc(heading)}</h1>` +
        `<p style="color:#555">${esc(detail)}</p>` +
        `<p><a href="/api/auth/login">Try signing in again</a> · <a href="/">Back to the portal</a></p>` +
        `</body>`,
    );
}

export function createAuthRouter(store: SessionStore = sessionStore): Router {
  const router = Router();

  router.get('/auth/me', (req, res) => {
    const cfg = settings.get().auth;
    const session = store.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.json({
      configured: Boolean(cfg),
      authenticated: Boolean(session),
      principal: session?.principal ?? null,
      // Surfaced so the settings screen can say which gate is actually in
      // force rather than implying one that is not configured.
      groupGate: cfg?.allowedGroups?.length ? cfg.allowedGroups : null,
    });
  });

  router.get('/auth/login', (req, res, next) => {
    void (async () => {
      const cfg = settings.get().auth;
      if (!cfg) {
        errorPage(
          res,
          503,
          'No identity provider is configured',
          'Set the OIDC issuer, client id and client secret in Settings before signing in.',
        );
        return;
      }
      try {
        const meta = await discover(cfg.issuer);
        const state = crypto.randomBytes(32).toString('base64url');
        const nonce = crypto.randomBytes(32).toString('base64url');
        const { verifier, challenge } = createPkcePair();
        store.startLogin(state, {
          codeVerifier: verifier,
          nonce,
          returnTo: safeReturnTo(req.query.returnTo),
        });
        const secure = needsSecureCookie(req);
        // Bound to the pending login's lifetime, not the session's: this
        // cookie exists only to prove the callback lands in the browser that
        // started the flow.
        res.setHeader(
          'Set-Cookie',
          serializeCookie(STATE_COOKIE, state, { maxAgeMs: 10 * 60 * 1000, secure }),
        );
        res.redirect(302, buildAuthorizeUrl(meta, cfg, { state, nonce, challenge }));
      } catch (err) {
        if (err instanceof AuthError) {
          errorPage(res, err.status, 'Could not reach the identity provider', err.message);
          return;
        }
        next(err);
      }
    })();
  });

  router.get('/auth/callback', (req, res, next) => {
    void (async () => {
      const cfg = settings.get().auth;
      if (!cfg) {
        errorPage(res, 503, 'No identity provider is configured', 'Sign-in is not available.');
        return;
      }

      // A provider-side refusal (consent denied, app not assigned) arrives as
      // ?error, not as an exception. Say so plainly instead of failing as if
      // the portal were broken.
      if (typeof req.query.error === 'string') {
        console.error(`oidc: provider returned error '${req.query.error}'`);
        errorPage(
          res,
          403,
          'The identity provider refused the sign-in',
          'It did not issue a token for this account. Check that the account is assigned to this application.',
        );
        return;
      }

      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE];
      const secure = needsSecureCookie(req);
      const clearState = serializeCookie(STATE_COOKIE, '', { maxAgeMs: 0, secure });

      if (!state || !code) {
        res.setHeader('Set-Cookie', clearState);
        errorPage(res, 400, 'Incomplete sign-in response', 'The provider did not return a code and state.');
        return;
      }
      // Constant-time compare so the cookie value cannot be recovered by
      // timing the mismatch.
      const sameState =
        Boolean(cookieState) &&
        cookieState.length === state.length &&
        crypto.timingSafeEqual(Buffer.from(cookieState), Buffer.from(state));
      if (!sameState) {
        res.setHeader('Set-Cookie', clearState);
        errorPage(
          res,
          400,
          'This sign-in did not start in this browser',
          'Start again from the portal rather than following a sign-in link from elsewhere.',
        );
        return;
      }

      const pending = store.takeLogin(state);
      if (!pending) {
        res.setHeader('Set-Cookie', clearState);
        errorPage(res, 400, 'This sign-in link has expired', 'Sign-in attempts are valid for ten minutes.');
        return;
      }

      try {
        const meta = await discover(cfg.issuer);
        const { idToken } = await exchangeCode(meta, cfg, { code, codeVerifier: pending.codeVerifier });
        const principal = await verifyIdToken(idToken, meta, cfg, pending.nonce);

        if (!isPermitted(principal, cfg)) {
          console.warn(`oidc: '${principal.name}' verified but is in none of the permitted groups`);
          res.setHeader('Set-Cookie', clearState);
          errorPage(
            res,
            403,
            'Your account is not permitted to use this portal',
            'The identity provider confirmed who you are, but you are not in a group this portal allows.',
          );
          return;
        }

        const session = store.create(principal);
        console.log(`auth: '${principal.name}' signed in`);
        res.setHeader('Set-Cookie', [
          clearState,
          serializeCookie(SESSION_COOKIE, session.id, {
            maxAgeMs: session.expiresAt - session.createdAt,
            secure,
          }),
        ]);
        res.redirect(302, pending.returnTo);
      } catch (err) {
        res.setHeader('Set-Cookie', clearState);
        if (err instanceof AuthError) {
          errorPage(res, err.status, 'Sign-in failed', err.message);
          return;
        }
        next(err);
      }
    })();
  });

  router.post('/auth/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    store.destroy(cookies[SESSION_COOKIE]);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, '', { maxAgeMs: 0, secure: needsSecureCookie(req) }),
    );
    res.json({ ok: true });
  });

  return router;
}

/**
 * The configuration routes, mounted separately.
 *
 * These live in their own router because createApp mounts `authRouter`
 * *before* the guard — it has to, or signing in would require being signed
 * in. Leaving the config routes in that router would have left an
 * unauthenticated caller able to point the portal at an identity provider of
 * their own choosing, which is a full authentication bypass dressed up as a
 * settings write. This router mounts after the guard instead.
 */
export function createAuthConfigRouter(): Router {
  const router = Router();

  // -- Configuration ---------------------------------------------------------
  //
  // Every network plane can be entered and tested from the Systems screen. The
  // identity provider — the one system that decides who may touch any of the
  // others — could only be configured by hand-editing settings.json, with no
  // feedback until a sign-in failed. These endpoints close that gap.
  //
  // Before a provider is configured there is no guard to apply, so these are
  // reachable unauthenticated on a fresh install. That exposure is bounded by
  // startServer refusing to bind a network-reachable address without auth: the
  // only caller who can get here is already on the loopback interface, and
  // could equally edit the settings file.

  router.get('/auth/config', (_req, res) => {
    res.json(authConfigView());
  });

  router.post(
    '/auth/test',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const stored = settings.get().auth;
      const pick = (key: keyof AuthSettings): string =>
        typeof body[key] === 'string' && (body[key] as string).trim()
          ? (body[key] as string).trim()
          : ((stored?.[key] as string | undefined) ?? '');

      const issuer = pick('issuer');
      const clientId = pick('clientId');
      const redirectUri = pick('redirectUri');
      // A masked secret means "keep the stored one" — the same round-trip rule
      // the settings merge uses, so testing a masked view tests the real thing.
      const submittedSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
      const clientSecret =
        submittedSecret && !isMasked(submittedSecret) ? submittedSecret : (stored?.clientSecret ?? '');

      if (!issuer) {
        res.status(400).json({ ok: false, message: 'issuer URL is required' });
        return;
      }
      const shape = validateIssuer(issuer);
      if (!shape.ok) {
        res.status(400).json({ ok: false, message: shape.reason });
        return;
      }

      const started = Date.now();
      // Always re-fetch. An operator retesting after fixing their provider is
      // owed the current answer, not an hour-old cached success.
      resetDiscoveryCache();
      let meta;
      try {
        meta = await discover(issuer);
      } catch (err) {
        const detail = err instanceof AuthError ? err.message : (err as Error).message;
        res.status(502).json({
          ok: false,
          message: detail,
          ms: Date.now() - started,
          hint: issuer.includes('/application/o/')
            ? null
            : 'Authentik has no server-wide discovery document — the issuer is ' +
              'https://<host>/application/o/<application-slug>/, including the trailing slash',
        });
        return;
      }

      const credentials = await probeClientCredentials(meta.token_endpoint, clientId, clientSecret);
      const ms = Date.now() - started;
      const cautions = redirectUriCautions(redirectUri);

      res.status(credentials.ok ? 200 : 502).json({
        ok: credentials.ok,
        message: `discovery succeeded at ${issuer} — ${credentials.message}`,
        ms,
        endpoints: {
          authorization: meta.authorization_endpoint,
          token: meta.token_endpoint,
          jwks: meta.jwks_uri,
        },
        cautions,
      });
    }),
  );

  router.put('/auth/config', (req, res) => {
    if (settings.authSource() === 'environment') {
      res.status(409).json({
        error:
          'the identity provider is configured through HPE_OIDC_* environment variables; ' +
          'change those and restart rather than saving here',
      });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const invalid = missingAuthFields(body, settings.get().auth);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    try {
      settings.update({ auth: body });
    } catch (err) {
      if (err instanceof SettingsConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    resetDiscoveryCache();
    res.json({
      ...authConfigView(),
      saved: true,
      // Saying "authentication enabled" here would be false: the guard was
      // chosen at boot and this process is still serving whatever it chose.
      restartRequired: !isAuthGuardInstalled(),
      note: isAuthGuardInstalled()
        ? 'Saved. Sign-in will use the new provider; existing sessions stay valid until they expire.'
        : 'Saved, but this process started without an identity provider and is still serving every route unauthenticated. Restart the server to enforce it.',
    });
  });

  router.delete('/auth/config', (_req, res) => {
    if (settings.authSource() === 'environment') {
      res.status(409).json({
        error:
          'the identity provider is configured through HPE_OIDC_* environment variables; ' +
          'unset those and restart rather than removing it here',
      });
      return;
    }
    settings.update({ auth: null });
    resetDiscoveryCache();
    res.json({
      ...authConfigView(),
      saved: true,
      restartRequired: isAuthGuardInstalled(),
      note: isAuthGuardInstalled()
        ? 'Removed from settings, but this process is still enforcing the guard it installed at boot — every route keeps requiring a session until the server restarts.'
        : 'Removed.',
    });
  });

  return router;
}

/**
 * The identity-provider configuration as it is safe to send over the API.
 *
 * `configured` and `active` are deliberately separate. The first says a
 * provider is recorded; the second says this process is actually enforcing
 * one. They differ for exactly as long as it takes to restart, and during that
 * window reporting only the first would tell an operator their portal is
 * protected when it is not.
 */
function authConfigView(): Record<string, unknown> {
  const cfg = settings.get().auth;
  const source = settings.authSource();
  return {
    configured: Boolean(cfg),
    active: isAuthGuardInstalled(),
    source,
    editable: source !== 'environment',
    issuer: cfg?.issuer ?? null,
    clientId: cfg?.clientId ?? null,
    clientSecret: cfg?.clientSecret ? MASK : null,
    redirectUri: cfg?.redirectUri ?? null,
    allowedGroups: cfg?.allowedGroups ?? null,
  };
}

/** Which required field, if any, is still missing once the body is merged in. */
function missingAuthFields(body: Record<string, unknown>, stored: AuthSettings | null): string | null {
  const has = (key: keyof AuthSettings): boolean => {
    const v = body[key];
    if (typeof v === 'string' && v.trim()) return true;
    return Boolean(stored?.[key]);
  };
  for (const key of ['issuer', 'clientId', 'clientSecret', 'redirectUri'] as const) {
    if (!has(key)) return `${key} is required`;
  }
  const issuer = typeof body.issuer === 'string' && body.issuer.trim() ? body.issuer.trim() : stored!.issuer;
  const shape = validateIssuer(issuer);
  if (!shape.ok) return shape.reason;
  const redirect =
    typeof body.redirectUri === 'string' && body.redirectUri.trim()
      ? body.redirectUri.trim()
      : stored!.redirectUri;
  try {
    new URL(redirect);
  } catch {
    return 'redirectUri must be a valid absolute URL';
  }
  return null;
}

/**
 * Things about the redirect URI worth saying out loud without failing the test.
 *
 * None of these can be proven wrong from here — a reverse proxy legitimately
 * changes both the host and, in principle, the path — so they are reported as
 * cautions rather than errors. Silently passing a redirect URI that cannot
 * work would only move the discovery to the first failed sign-in.
 */
function redirectUriCautions(redirectUri: string): string[] {
  const out: string[] = [];
  if (!redirectUri) {
    out.push('no redirect URI is set — sign-in cannot start without one');
    return out;
  }
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    out.push(`redirect URI '${redirectUri}' is not a valid absolute URL`);
    return out;
  }
  if (url.pathname.replace(/\/+$/, '') !== '/api/auth/callback') {
    out.push(
      `redirect URI path is '${url.pathname}'; this server only handles /api/auth/callback, ` +
        'so unless a proxy rewrites it the provider will return to a route that does not exist',
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (url.protocol !== 'https:' && !loopback) {
    out.push('redirect URI is not HTTPS, so the authorization code would cross the network in clear text');
  }
  out.push('this must match a redirect URI registered on the provider exactly, character for character');
  return out;
}

/**
 * Ask the token endpoint whether the client id and secret are real.
 *
 * There is no way to complete an authorization-code flow without a browser, so
 * instead we present the credentials with a deliberately invalid code. A
 * provider that rejects the *client* answers `invalid_client`; one that
 * accepts the client and rejects only the code answers `invalid_grant`. That
 * distinction is the whole test, and it is why this reports the credentials as
 * genuinely checked rather than merely reachable.
 */
async function probeClientCredentials(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
): Promise<{ ok: boolean; message: string }> {
  if (!clientId || !clientSecret) {
    return { ok: false, message: 'no client id and secret to check — discovery only proves the provider is reachable' };
  }
  // `Response` in this file is Express's, so the fetch response type is taken
  // from fetch itself rather than named.
  let probe: Awaited<ReturnType<typeof fetch>>;
  try {
    probe = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'portal-credential-probe',
        redirect_uri: 'https://invalid.invalid/',
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, message: `could not reach the token endpoint: ${(err as Error).message}` };
  }
  let error = '';
  try {
    error = String(((await probe.json()) as { error?: unknown }).error ?? '');
  } catch {
    /* a non-JSON body tells us nothing beyond the status, handled below */
  }
  if (error === 'invalid_client' || probe.status === 401) {
    return { ok: false, message: 'the provider rejected the client id or secret' };
  }
  if (error === 'invalid_grant' || error === 'invalid_request') {
    return { ok: true, message: 'the provider accepted the client id and secret' };
  }
  return {
    ok: true,
    message:
      `the provider answered HTTP ${probe.status}${error ? ` (${error})` : ''} to a credential probe — ` +
      'it did not reject the client, but the credentials are not confirmed until the first sign-in',
  };
}

export const authRouter = createAuthRouter();
export const authConfigRouter = createAuthConfigRouter();
