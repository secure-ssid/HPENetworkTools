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
import { systemsRouter } from './routes/systems';
import { inventoryRouter } from './routes/inventory';
import { SsidDirectWriteError } from './services/ssidDirectWrite';

export function createApp(): express.Express {
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

export function startServer(port: number = Number(process.env.PORT ?? 5173)) {
  settings.load();
  poller.start();
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`server listening on http://localhost:${port} (demoMode: ${settings.get().demoMode})`);
  });
  // Recorded SSH shell bridge: /api/terminal/:name (see services/terminal.ts).
  attachTerminalWs(server);
  return server;
}

/* eslint-disable-next-line */
if (typeof require !== 'undefined' && require.main === module) {
  startServer();
}
