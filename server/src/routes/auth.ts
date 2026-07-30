/**
 * server/src/routes/auth.ts — OIDC sign-in endpoints.
 *
 *   GET  /api/auth/me        who am I, and is SSO even configured
 *   GET  /api/auth/login     start the flow → 302 to the identity provider
 *   GET  /api/auth/callback  provider returns here → session cookie → 302 back
 *   POST /api/auth/logout    drop the session
 *
 * All four are reachable without a session (see OPEN_PATHS in
 * services/auth.ts) — guarding the login route would make login impossible,
 * and `me` has to be answerable before the client knows whether it is signed
 * in.
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
import { settings } from '../config/settings';
import {
  AuthError,
  SESSION_COOKIE,
  STATE_COOKIE,
  buildAuthorizeUrl,
  createPkcePair,
  discover,
  exchangeCode,
  isPermitted,
  needsSecureCookie,
  parseCookies,
  safeReturnTo,
  serializeCookie,
  sessionStore,
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

export const authRouter = createAuthRouter();
