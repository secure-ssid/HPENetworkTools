/**
 * server/src/index.ts — Express app wiring.
 *
 * createApp() is side-effect free (no listener, no poller) so tests can mount
 * it in-process. startServer() loads settings, starts the poller and listens.
 * The entry guard only fires when run directly (`tsx src/index.ts`).
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { settings } from './config/settings';
import { poller } from './services/poller';
import { attachTerminalWs, terminalManager } from './services/terminal';
import { chatRouter } from './routes/chat';
import { alertsRouter } from './routes/alerts';
import { clientsRouter } from './routes/clients';
import { configureRouter } from './routes/configure';
import { centralWebhooksRouter } from './routes/centralWebhooks';
import { devicesRouter } from './routes/devices';
import { diagnosticsRouter } from './routes/diagnostics';
import { screensRouter } from './routes/screens';
import { settingsRouter } from './routes/settings';
import { sseRouter } from './routes/sse';
import { greenlakeRouter } from './routes/greenlake';
import { systemsRouter } from './routes/systems';
import { inventoryRouter } from './routes/inventory';
import { authRouter } from './routes/auth';
import { actorContext, authenticateUpgrade, requireAuth, requireSameOrigin, type AuthGuard } from './services/auth';
import { SsidDirectWriteError } from './services/ssidDirectWrite';

export interface AppOptions {
  /**
   * Access guard for /api. Omitted means every route is open.
   *
   * The default is open because createApp() is mounted in-process by well
   * over a thousand tests that have no business holding a session, and by the
   * dev server on loopback. startServer() is the path that actually serves
   * traffic and it decides the guard itself (see below) — so the permissive
   * default is never what a real deployment gets.
   */
  auth?: AuthGuard;
}

export function createApp(opts: AppOptions = {}): express.Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Request log: METHOD path status ms
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Cross-site write protection, ahead of everything including login.
  //
  // This is not conditional on auth being configured, because the
  // unauthenticated case is the one that needs it most: with no session cookie
  // there is no ambient authority for SameSite to guard, so any page open in
  // the operator's browser could POST to http://127.0.0.1:5173 and change
  // production configuration. Requests with no Origin at all (curl, scripts)
  // pass — see isAllowedOrigin for why that is the right call.
  app.use('/api', requireSameOrigin());

  // Auth routes mount ahead of the guard: guarding /api/auth/login would make
  // signing in impossible, and /api/auth/me has to answer before the client
  // knows whether it is signed in.
  app.use('/api', authRouter);
  if (opts.auth) app.use('/api', opts.auth);

  // After the guard, so req.principal is populated. Every change-log line
  // written while handling this request is attributed to whoever it names.
  app.use('/api', actorContext());

  // Recorded shell sessions (data/shell-logs) — optional ?device=<name> filter,
  // itself narrowed by ?plane=&serial= to one physical device when the name
  // is shared. Without a device filter this is an unscoped admin dump (no
  // display name to disambiguate); with one, terminalManager.listSessionsForDevice
  // is the single place that decides which recordings a shared name may see
  // (see server/src/services/terminal.ts).
  app.get('/api/terminal/sessions', (req, res) => {
    const device = typeof req.query.device === 'string' ? req.query.device : null;
    if (!device) {
      res.json({ sessions: terminalManager.listSessions() });
      return;
    }
    const identity = {
      plane: typeof req.query.plane === 'string' ? req.query.plane : undefined,
      serial: typeof req.query.serial === 'string' ? req.query.serial : undefined,
    };
    const result = terminalManager.listSessionsForDevice(device, identity);
    if (result.invalid) {
      res.status(400).json({ error: result.invalid });
      return;
    }
    res.json({ sessions: result.sessions, ambiguous: result.ambiguous });
  });

  // A transcript is gated by the same device+identity rule as the listing
  // above — ?device=<name> is required so a caller that only knows a file
  // name (which carries no secret, but does carry another device's shell
  // output) cannot read a recording that does not belong to it.
  app.get('/api/terminal/sessions/:file', (req, res) => {
    const device = typeof req.query.device === 'string' ? req.query.device : null;
    if (!device) {
      res.status(400).json({ error: 'device is required to read a recorded session' });
      return;
    }
    const identity = {
      plane: typeof req.query.plane === 'string' ? req.query.plane : undefined,
      serial: typeof req.query.serial === 'string' ? req.query.serial : undefined,
    };
    const result = terminalManager.readSessionForDevice(req.params.file, device, identity);
    if (result.invalid) {
      res.status(400).json({ error: result.invalid });
      return;
    }
    if (result.ambiguous) {
      res.status(409).json({ error: `'${device}' names multiple devices — pass plane and serial to pick one` });
      return;
    }
    if (!result.transcript) {
      res.status(404).json({ error: 'unknown session recording' });
      return;
    }
    res.json(result.transcript);
  });

  app.use('/api', screensRouter);
  app.use('/api', settingsRouter);
  app.use('/api', systemsRouter);
  app.use('/api', inventoryRouter);
  app.use('/api', sseRouter);
  app.use('/api', greenlakeRouter);
  app.use('/api', chatRouter);
  app.use('/api', configureRouter);
  app.use('/api', centralWebhooksRouter);
  app.use('/api', devicesRouter);
  app.use('/api', diagnosticsRouter);
  app.use('/api', clientsRouter);
  app.use('/api', alertsRouter);

  // Unknown API route → consistent JSON 404
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Serve the built web app (single-port mode) with SPA fallback.
  const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  // Consistent { error } JSON for anything thrown in a handler. 5xx detail
  // (fs paths, upstream URLs, …) stays in the server log, never in responses.
  //
  // SsidDirectWriteError is the one 5xx exception: its 502 "central did not
  // answer the SSID write; the outcome is unknown" is a fixed, secret-free
  // constant the class always throws verbatim (never an interpolated
  // upstream message), so surfacing err.message for it is safe and useful —
  // the caller needs to know the outcome is unknown, not just "internal
  // error". Every other 5xx (arbitrary thrown errors, unexpected faults)
  // still collapses to the generic message so raw upstream detail never leaks.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`error: ${err.message}`);
    if (res.headersSent) return;
    const status = err.status ?? 500;
    const safe5xxMessage = err instanceof SsidDirectWriteError ? err.message : undefined;
    res.status(status).json({ error: status >= 500 ? (safe5xxMessage ?? 'internal error') : err.message || 'internal error' });
  });

  return app;
}

/**
 * Start the portal.
 *
 * Two decisions are made here rather than in createApp(), because this is the
 * function that actually serves traffic to a browser:
 *
 * **Bind host.** Defaults to loopback. This server brokers writes to
 * production network infrastructure and bridges SSH to switches; binding every
 * interface would put that surface on whatever network the machine is on.
 * Exposing it deliberately is still possible (HPE_BIND_HOST=0.0.0.0) but it
 * has to be a decision someone makes, not the default that ships.
 *
 * **Authentication.** When an identity provider is configured, every /api
 * route requires a session. When one is not:
 *
 *   - bound off-loopback → refuse to start. An unauthenticated portal on a
 *     routable address is not a degraded mode, it is an open door to
 *     production switches, and there is no warning loud enough to make that
 *     acceptable. HPE_ALLOW_NO_AUTH=1 overrides it for someone who genuinely
 *     means it (a private lab segment, a host firewall in front).
 *   - bound to loopback → start, and say so on every boot. Reaching it still
 *     requires code execution on this machine, so this is a real if modest
 *     position — but it must never be a quiet one.
 */
export function startServer(
  port: number = Number(process.env.PORT ?? 5173),
  host: string = process.env.HPE_BIND_HOST ?? '127.0.0.1',
) {
  settings.load();
  // Environment overlay first: a deployment may keep the client secret out of
  // settings.json entirely, and the refuse-to-start check below has to see the
  // configuration that will actually be used, not just what is on disk.
  const envAuth = settings.overlayEnvAuth();
  const authConfigured = Boolean(settings.get().auth);
  const loopback = isLoopbackHost(host);

  if (!authConfigured && !loopback && process.env.HPE_ALLOW_NO_AUTH !== '1') {
    console.error(
      `REFUSING TO START: asked to bind ${host}, which is reachable from the network, with no identity provider configured.\n` +
        `  Anyone who can reach this port could change production configuration and open switch shells.\n` +
        `  Configure OIDC under Settings, or bind loopback (unset HPE_BIND_HOST), or set HPE_ALLOW_NO_AUTH=1 if you truly mean it.`,
    );
    throw new Error('refusing to serve an unauthenticated portal on a network-reachable address');
  }

  poller.start();
  const app = createApp(authConfigured ? { auth: requireAuth() } : {});
  const server = app.listen(port, host, () => {
    console.log(
      `server listening on http://${host}:${port} (demoMode: ${settings.get().demoMode}, ` +
        `auth: ${authConfigured ? `oidc via ${envAuth ? 'environment' : 'settings'}` : 'NONE'})`,
    );
    if (!authConfigured) {
      console.warn(
        `WARNING: no identity provider is configured, so every API route is open and every audit line will say 'operator' ` +
          `rather than naming who made the change. Configure OIDC under Settings to record real identity.`,
      );
    }
    if (!loopback) {
      console.warn(`WARNING: bound to ${host}, which is reachable from the network.`);
    }
  });
  // Recorded SSH shell bridge: /api/terminal/:name (see services/terminal.ts).
  // The upgrade never passes through Express middleware, so the guard has to
  // be handed to it explicitly or the SSH bridge would stay open while the
  // API was closed.
  attachTerminalWs(server, terminalManager, authConfigured ? authenticateUpgrade() : undefined);
  return server;
}

/** Loopback spellings that keep the listener off the network. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.');
}

if (typeof require !== 'undefined' && require.main === module) {
  startServer();
}
