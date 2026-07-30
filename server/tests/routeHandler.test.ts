/**
 * server/tests/routeHandler.test.ts — the shared async route wrapper.
 *
 * Express 4 does not await a handler's promise. Without this wrapper a
 * rejection inside an async route is an unhandled rejection and the client's
 * request simply hangs until it times out — the error never reaches the error
 * middleware and nothing is logged against the request. Ten route modules each
 * had their own copy of the fix, nine identical and one quietly more capable,
 * which is exactly the drift worth removing.
 */

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { h } from '../src/routes/handler';

let server: Server | null = null;

async function serve(build: (app: express.Express) => void): Promise<string> {
  const app = express();
  build(app);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('h()', () => {
  it('passes a normal response straight through', async () => {
    const base = await serve((app) => {
      app.get('/ok', h(async (_req, res) => {
        await Promise.resolve();
        res.json({ ok: true });
      }));
    });
    const res = await fetch(`${base}/ok`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('routes a rejected promise to the error middleware instead of hanging', async () => {
    const base = await serve((app) => {
      app.get('/boom', h(async () => {
        await Promise.resolve();
        throw new Error('handler exploded');
      }));
    });
    const res = await fetch(`${base}/boom`, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'handler exploded' });
  });

  it('accepts a synchronous handler too', async () => {
    // The diagnostics copy allowed this and the other nine did not. The shared
    // one takes the more general contract so the difference cannot come back.
    const base = await serve((app) => {
      app.get('/sync', h((_req, res) => {
        res.json({ ok: 'sync' });
      }));
    });
    expect(await (await fetch(`${base}/sync`)).json()).toEqual({ ok: 'sync' });
  });

  it('routes a synchronous throw to the error middleware as well', async () => {
    const base = await serve((app) => {
      app.get('/sync-boom', h(() => {
        throw new Error('sync exploded');
      }));
    });
    const res = await fetch(`${base}/sync-boom`, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'sync exploded' });
  });

  it('lets a handler that calls next() reach the following handler', async () => {
    const base = await serve((app) => {
      app.get(
        '/chain',
        h(async (_req, _res, next) => {
          await Promise.resolve();
          next();
        }),
        (_req, res) => res.json({ ok: 'chained' }),
      );
    });
    expect(await (await fetch(`${base}/chain`)).json()).toEqual({ ok: 'chained' });
  });
});
