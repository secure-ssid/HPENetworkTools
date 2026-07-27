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
import { devicesRouter } from './routes/devices';
import { screensRouter } from './routes/screens';
import { settingsRouter } from './routes/settings';
import { systemsRouter } from './routes/systems';

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

  // Recorded shell sessions (data/shell-logs) — optional ?device=<name> filter.
  app.get('/api/terminal/sessions', (req, res) => {
    const device = typeof req.query.device === 'string' ? req.query.device : null;
    const sessions = terminalManager.listSessions().filter((s) => !device || s.device === device);
    res.json({ sessions });
  });

  app.get('/api/terminal/sessions/:file', (req, res) => {
    const transcript = terminalManager.readSession(req.params.file);
    if (!transcript) {
      res.status(404).json({ error: 'unknown session recording' });
      return;
    }
    res.json(transcript);
  });

  app.use('/api', screensRouter);
  app.use('/api', settingsRouter);
  app.use('/api', systemsRouter);
  app.use('/api', chatRouter);
  app.use('/api', configureRouter);
  app.use('/api', devicesRouter);
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
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`error: ${err.message}`);
    if (res.headersSent) return;
    const status = err.status ?? 500;
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message || 'internal error' });
  });

  return app;
}

export function startServer(port: number = Number(process.env.PORT ?? 8177)) {
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
