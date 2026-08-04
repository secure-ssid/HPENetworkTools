/**
 * server/src/routes/greenlake.ts — HPE GreenLake platform management.
 *
 *   GET  /api/greenlake/inventory        cached GreenLakeInventory (poller cache)
 *   GET  /api/greenlake/export           CSV of one section (?part=users|locations|roles)
 *   POST /api/greenlake/actions/:action  one direct write {fields, reviewConfirmed?}
 *
 * `:action` is checked against the shared GREENLAKE_WRITE_ACTIONS allowlist
 * before it reaches an adapter method: there is no route here that accepts an
 * arbitrary path, method or body, and no caller-supplied URL is ever forwarded
 * to the GLP API. Writes additionally require capabilities().directWrite (the
 * operator-declared write scope) and, only in explicit hardened mode, an
 * explicit `reviewConfirmed: true`.
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
import { GREENLAKE_EXPORT_PARTS, type GreenLakeExportPart } from '@hpe/shared';
import { h } from './handler';
import { sendCsv } from '../lib/csv';
import { queryString } from '../lib/query';
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

/**
 * Optional GreenLake export filters shared by the route and unit tests.
 * `status` is exact (case-insensitive) and only meaningful for part=users —
 * unknown/empty values are honest no-ops. `q` is a substring over the caller-
 * supplied identity fields.
 */
export function matchesGreenLakeExportQ(
  parts: Array<string | number | null | undefined>,
  qRaw: string,
): boolean {
  const q = qRaw.trim().toLowerCase();
  if (!q) return true;
  return parts
    .map((p) => String(p ?? ''))
    .join(' ')
    .toLowerCase()
    .includes(q);
}

/** Exact case-insensitive status match; empty want → always true. */
export function matchesGreenLakeUserStatus(
  status: string | null | undefined,
  wantRaw: string,
): boolean {
  const want = wantRaw.trim().toLowerCase();
  if (!want) return true;
  return String(status ?? '')
    .trim()
    .toLowerCase() === want;
}

/**
 * GET /api/greenlake/export?part=users|locations|roles — CSV of one cached
 * workspace section. Unavailable sections export headers only (not invented
 * rows). Optional `q=` substring; `status=` exact on users only. No secrets
 * or vendor bodies.
 *
 * Loop 121: shared queryString for part/q/status (trim; non-string → '' →
 * honest defaults / no-ops). Named-unknown part still 400.
 */
greenlakeRouter.get(
  '/greenlake/export',
  h(async (req, res) => {
    try {
      const partRaw = queryString(req, 'part').toLowerCase();
      const normalized =
        partRaw === 'roleassignments' || partRaw === 'role_assignments'
          ? 'roles'
          : partRaw === ''
            ? 'users'
            : partRaw;
      const part = (GREENLAKE_EXPORT_PARTS as readonly string[]).includes(normalized)
        ? (normalized as GreenLakeExportPart)
        : null;
      if (part === null) {
        res.status(400).json({ error: "part must be 'users', 'locations', or 'roles'" });
        return;
      }
      const inv = greenlakeObjects.inventory();
      const q = queryString(req, 'q');
      const statusWant = queryString(req, 'status');

      if (part === 'users') {
        const unavailable = inv.unavailable.includes('users');
        const sectionStatus = inv.readStatus.users?.state === 'failed' ? 'failed' : unavailable ? 'unavailable' : 'ok';
        const users = unavailable
          ? []
          : inv.users.filter(
              (u) =>
                matchesGreenLakeUserStatus(u.status, statusWant) &&
                matchesGreenLakeExportQ(
                  [u.id, u.username, u.firstName, u.lastName, u.status, u.lastLogin],
                  q,
                ),
            );
        sendCsv(
          res,
          'greenlake-users.csv',
          ['id', 'username', 'firstName', 'lastName', 'status', 'lastLogin', 'sectionStatus'],
          users.map((u) => [
            u.id,
            u.username,
            u.firstName ?? '',
            u.lastName ?? '',
            u.status ?? '',
            u.lastLogin ?? '',
            sectionStatus,
          ]),
        );
        return;
      }
      if (part === 'locations') {
        const unavailable = inv.unavailable.includes('locations');
        const sectionStatus =
          inv.readStatus.locations?.state === 'failed' ? 'failed' : unavailable ? 'unavailable' : 'ok';
        const locations = unavailable
          ? []
          : inv.locations.filter((l) =>
              matchesGreenLakeExportQ(
                [l.id, l.name, l.type, l.address, l.country, l.deviceCount],
                q,
              ),
            );
        sendCsv(
          res,
          'greenlake-locations.csv',
          ['id', 'name', 'type', 'address', 'country', 'deviceCount', 'sectionStatus'],
          locations.map((l) => [
            l.id,
            l.name,
            l.type ?? '',
            l.address ?? '',
            l.country ?? '',
            l.deviceCount == null ? '' : String(l.deviceCount),
            sectionStatus,
          ]),
        );
        return;
      }
      const unavailable = inv.unavailable.includes('roleAssignments');
      const sectionStatus =
        inv.readStatus.roleAssignments?.state === 'failed' ? 'failed' : unavailable ? 'unavailable' : 'ok';
      const roles = unavailable
        ? []
        : inv.roleAssignments.filter((r) =>
            matchesGreenLakeExportQ(
              [
                r.id,
                r.principal,
                r.principalType,
                r.principalName,
                r.role,
                r.roleGrn,
                r.scope.join(' '),
                r.source,
              ],
              q,
            ),
          );
      sendCsv(
        res,
        'greenlake-role-assignments.csv',
        ['id', 'principal', 'principalType', 'principalName', 'role', 'roleGrn', 'scope', 'source', 'sectionStatus'],
        roles.map((r) => [
          r.id,
          r.principal,
          r.principalType,
          r.principalName ?? '',
          r.role,
          r.roleGrn,
          r.scope.join('; '),
          r.source ?? '',
          sectionStatus,
        ]),
      );
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
