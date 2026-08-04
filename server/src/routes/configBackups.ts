/**
 * Versioned running-config backup API.
 *
 * GET /api/config-backups                          estate list + summary
 * GET /api/config-backups/export                   CSV roster (+ optional filters)
 * GET /api/config-backups/:device/versions         version metadata, newest first
 * GET /api/config-backups/:device/diff?from=&to=   unified LCS line-diff
 *
 * Read-only by construction: there is no POST here because collection is a
 * scheduled sweep (services/configBackup.ts), never an operator-triggered
 * device action — and every collection channel is itself read-only.
 * Export never includes config bodies — only roster metadata.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { ConfigBackupDeviceRow, ConfigBackupListEnvelope, ConfigBackupStatus } from '@hpe/shared';
import { sendCsv } from '../lib/csv';
import { queryFlag, queryOneOf, queryString } from '../lib/query';
import { dataSource } from './screens/context';
import { ConfigBackupError, configBackups, type ConfigBackupService } from '../services/configBackup';

const BACKUP_STATUSES = ['ok', 'pending', 'no-source', 'failed'] as const satisfies readonly ConfigBackupStatus[];

/**
 * Optional roster filters shared by list + CSV export (Loop 96/105):
 * - `drift=0|1|true|false` — Compliance drift section parity
 * - `q=` — substring on device/plane/ip/status/note/latestSource
 * - `plane=` — exact plane label (case-insensitive)
 * - `status=` — exact ConfigBackupStatus (unknown → no-op)
 * Unknown flag/enum values are honest no-ops.
 */
export function filterConfigBackupRows(
  req: Request,
  rows: readonly ConfigBackupDeviceRow[],
): ConfigBackupDeviceRow[] {
  const drift = queryFlag(req, 'drift');
  const q = queryString(req, 'q').toLowerCase();
  const plane = queryString(req, 'plane').toLowerCase();
  const status = queryOneOf(req, 'status', BACKUP_STATUSES);

  return rows.filter((r) => {
    if (drift === true && r.drift !== true) return false;
    if (drift === false && r.drift === true) return false;
    if (status && r.status !== status) return false;
    if (plane && String(r.plane ?? '').toLowerCase() !== plane) return false;
    if (q) {
      const hay = [r.device, r.plane, r.ip, r.status, r.note, r.latest?.source]
        .map((x) => String(x ?? '').toLowerCase())
        .join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function createConfigBackupsRouter(service: ConfigBackupService = configBackups): Router {
  const router = Router();

  router.get('/config-backups', (req, res) => {
    const demo = dataSource() === 'demo';
    const devices = filterConfigBackupRows(req, service.listDeviceRows());
    const envelope: ConfigBackupListEnvelope = {
      dataSource: demo ? 'demo' : 'live',
      devices,
      // Estate rollup stays unfiltered so the Compliance card is not skewed by
      // a narrow q/plane/status view of the same endpoint.
      summary: service.summary(),
      ...(demo
        ? { note: 'synthesized demo snapshots — no device was contacted' }
        : {}),
    };
    res.json(envelope);
  });

  /**
   * GET /api/config-backups/export — CSV of the backup roster (no config bodies).
   * Same filters as the list endpoint (`drift` / `q` / `plane` / `status`).
   * Registered before `/:device` so "export" is never treated as a device name.
   */
  router.get('/config-backups/export', (req, res) => {
    const rows = filterConfigBackupRows(req, service.listDeviceRows());
    sendCsv(
      res,
      'config-backups.csv',
      [
        'device',
        'plane',
        'ip',
        'status',
        'versions',
        'drift',
        'latestVersion',
        'latestTakenAt',
        'latestSource',
        'note',
      ],
      rows.map((r) => [
        r.device,
        r.plane ?? '',
        r.ip ?? '',
        r.status,
        r.versions,
        r.drift ? 'yes' : 'no',
        r.latest?.version ?? '',
        r.latest?.takenAt ?? '',
        r.latest?.source ?? '',
        r.note ?? '',
      ]),
    );
  });

  router.get('/config-backups/:device/versions', (req, res, next) => {
    try {
      const device = req.params.device;
      if (!service.knownDevice(device)) {
        throw new ConfigBackupError(404, `unknown device '${device}'`);
      }
      res.json({ device, versions: service.listVersions(device) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/config-backups/:device/diff', (req, res, next) => {
    try {
      res.json(service.diffVersions(req.params.device, req.query.from, req.query.to));
    } catch (err) {
      next(err);
    }
  });

  router.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ConfigBackupError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  });

  return router;
}

export const configBackupsRouter = createConfigBackupsRouter();
