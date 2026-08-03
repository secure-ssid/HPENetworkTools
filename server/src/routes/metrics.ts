/**
 * Metrics history API.
 *
 * GET /api/metrics   per-plane and per-device count series (see
 *                    services/metricsHistory.ts) for the table sparklines,
 *                    plus the additive `anomalies` block: each series
 *                    flagged against its own median (shared/anomaly.ts),
 *                    computed on read. Older clients ignore the block; older
 *                    servers send none — both directions degrade to "no
 *                    markers", never to a parse failure.
 *
 * Read-only by construction: sampling is a scheduled service, never an
 * operator-triggered action — same shape as the config-backups API.
 */

import { Router } from 'express';
import { metricsHistory, type MetricsHistoryService } from '../services/metricsHistory';

export function createMetricsRouter(service: MetricsHistoryService = metricsHistory): Router {
  const router = Router();

  router.get('/metrics', (_req, res) => {
    res.json(service.envelope());
  });

  return router;
}

export const metricsRouter = createMetricsRouter();
