/**
 * server/src/routes/greenlake.ts — HPE GreenLake platform management.
 *
 *   GET  /api/greenlake/inventory        cached GreenLakeInventory (poller cache)
 *   POST /api/greenlake/actions/:action  one reviewed write {fields, reviewConfirmed}
 *
 * `:action` is checked against the shared GREENLAKE_WRITE_ACTIONS allowlist
 * before it reaches an adapter method: there is no route here that accepts an
 * arbitrary path, method or body, and no caller-supplied URL is ever forwarded
 * to the GLP API. Writes additionally require capabilities().directWrite (the
 * operator-declared write scope) AND an explicit `reviewConfirmed: true` — the
 * review gate server/src/services/ssidDirectWrite.ts uses for Central's direct
 * SSID writes, standing in for a ticket reference this plane has none of.
 *
 * The inventory response reports per-section read status. A section listed in
 * `unavailable` returned no data because the read FAILED — its array is not an
 * authoritative empty list, and the screen must render it as a failure.
 *
 * `outcome` is either `applied` (the workspace performed the change) or
 * `accepted` (the workspace took a 202 and validates asynchronously — the
 * subscription endpoints). The two are never collapsed.
 */

import { Router, type Response } from 'express';
import { h } from './handler';
import {
  GreenLakeObjectsError,
  GreenLakeObjectsService,
  greenlakeObjects,
  greenlakeObjectsErrorBody,
} from '../services/greenlakeObjects';

export const greenlakeRouter = Router();

/** GreenLakeObjectsError carries its own HTTP status; anything else is a real
 *  bug and goes to the shared error middleware rather than being swallowed. */
function reportOrThrow(err: unknown, res: Response): void {
  if (err instanceof GreenLakeObjectsError) {
    if (err.status >= 500) console.error(`error: ${err.message}`);
    res.status(err.status).json(greenlakeObjectsErrorBody(err));
    return;
  }
  throw err;
}

greenlakeRouter.get(
  '/greenlake/inventory',
  h(async (_req, res) => {
    try {
      const inventory = greenlakeObjects.inventory();
      res.json({ ...inventory, canWrite: greenlakeObjects.canWrite() });
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);

greenlakeRouter.post(
  '/greenlake/actions/:action',
  h(async (req, res) => {
    try {
      const action = GreenLakeObjectsService.assertAction(req.params.action);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fields =
        body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
          ? (body.fields as Record<string, unknown>)
          : {};
      res.json(await greenlakeObjects.write(action, fields, body.reviewConfirmed));
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);
