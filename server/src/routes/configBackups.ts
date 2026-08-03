/**
 * Versioned running-config backup API.
 *
 * GET /api/config-backups                          estate list + summary
 * GET /api/config-backups/:device/versions         version metadata, newest first
 * GET /api/config-backups/:device/diff?from=&to=   unified LCS line-diff
 *
 * Read-only by construction: there is no POST here because collection is a
 * scheduled sweep (services/configBackup.ts), never an operator-triggered
 * device action — and every collection channel is itself read-only.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { ConfigBackupListEnvelope } from '@hpe/shared';
import { dataSource } from './screens/context';
import { ConfigBackupError, configBackups, type ConfigBackupService } from '../services/configBackup';

export function createConfigBackupsRouter(service: ConfigBackupService = configBackups): Router {
  const router = Router();

  router.get('/config-backups', (_req, res) => {
    const demo = dataSource() === 'demo';
    const envelope: ConfigBackupListEnvelope = {
      dataSource: demo ? 'demo' : 'live',
      devices: service.listDeviceRows(),
      summary: service.summary(),
      ...(demo
        ? { note: 'synthesized demo snapshots — no device was contacted' }
        : {}),
    };
    res.json(envelope);
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
