/**
 * server/src/routes/handler.ts — the async route wrapper.
 *
 * Express 4 does not await a handler's promise, so a rejection inside an
 * `async` route is an unhandled rejection: the client's request hangs until it
 * times out and the error never reaches the error middleware. `h()` is the
 * one-line fix, and it was reimplemented in ten route modules — nine of them
 * identical, one (diagnostics) quietly more capable because it also accepted
 * synchronous handlers.
 *
 * That divergence is the reason to extract it rather than leave ten copies
 * that happen to agree today. This is the more general form: a handler may
 * return a promise or nothing, and either way a failure lands on `next`.
 */

import type { NextFunction, Request, Response } from 'express';

export type RouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

/** Wrap a route so a rejected promise becomes an Express error, not a hung request. */
export function h(fn: RouteHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
