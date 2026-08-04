/**
 * Metrics history API.
 *
 * GET /api/metrics          per-plane and per-device count series (see
 *                           services/metricsHistory.ts) for the table sparklines,
 *                           plus the additive `anomalies` block: each series
 *                           flagged against its own median (shared/anomaly.ts),
 *                           computed on read. Older clients ignore the block; older
 *                           servers send none — both directions degrade to "no
 *                           markers", never to a parse failure.
 * GET /api/metrics/export   CSV of series samples or anomaly flags (?part=)
 *
 * Read-only by construction: sampling is a scheduled service, never an
 * operator-triggered action — same shape as the config-backups API.
 */

import { Router, type Request } from 'express';
import {
  METRICS_EXPORT_PARTS,
  type MetricsEnvelopeWithAnomalies,
  type MetricsExportPart,
} from '@hpe/shared';
import { sendCsv } from '../lib/csv';
import { metricsHistory, type MetricsHistoryService } from '../services/metricsHistory';

const PART_SET = new Set<string>(METRICS_EXPORT_PARTS);

/** Parse `?part=series|anomalies` (default series). Unknown → null. */
export function parseMetricsExportPart(req: Request): MetricsExportPart | null {
  const raw = typeof req.query.part === 'string' ? req.query.part.trim().toLowerCase() : '';
  if (!raw) return 'series';
  return PART_SET.has(raw) ? (raw as MetricsExportPart) : null;
}

/** Flatten plane + device-client samples into CSV rows (scope/key/metric/t/v). */
export function metricsSeriesRows(envelope: MetricsEnvelopeWithAnomalies): unknown[][] {
  const rows: unknown[][] = [];
  for (const [plane, series] of Object.entries(envelope.planes)) {
    for (const metric of ['devices', 'devicesDown', 'clients', 'alerts'] as const) {
      for (const p of series[metric]) {
        rows.push(['plane', plane, metric, p.t, p.v]);
      }
    }
  }
  for (const [device, points] of Object.entries(envelope.deviceClients)) {
    for (const p of points) {
      rows.push(['device', device, 'clients', p.t, p.v]);
    }
  }
  return rows;
}

/** Flatten anomaly flags into CSV rows (scope/key/metric/t/v/direction/z/index). */
export function metricsAnomalyRows(envelope: MetricsEnvelopeWithAnomalies): unknown[][] {
  const rows: unknown[][] = [];
  const block = envelope.anomalies;
  for (const [plane, byMetric] of Object.entries(block.planes)) {
    if (!byMetric) continue;
    for (const metric of ['devices', 'devicesDown', 'clients', 'alerts'] as const) {
      const flags = byMetric[metric];
      if (!flags) continue;
      for (const f of flags) {
        rows.push(['plane', plane, metric, f.t, f.v, f.direction, f.z, f.index]);
      }
    }
  }
  for (const [device, flags] of Object.entries(block.deviceClients)) {
    for (const f of flags) {
      rows.push(['device', device, 'clients', f.t, f.v, f.direction, f.z, f.index]);
    }
  }
  return rows;
}

export function createMetricsRouter(service: MetricsHistoryService = metricsHistory): Router {
  const router = Router();

  router.get('/metrics', (_req, res) => {
    res.json(service.envelope());
  });

  /**
   * GET /api/metrics/export?part=series|anomalies — CSV of sparkline samples
   * or anomaly flags. Counts only; never secrets or vendor bodies.
   */
  router.get('/metrics/export', (req, res) => {
    const part = parseMetricsExportPart(req);
    if (!part) {
      res.status(400).json({ error: `part must be one of ${METRICS_EXPORT_PARTS.join('|')}` });
      return;
    }
    const envelope = service.envelope();
    if (part === 'anomalies') {
      sendCsv(
        res,
        'metrics-anomalies.csv',
        ['scope', 'key', 'metric', 't', 'v', 'direction', 'z', 'index'],
        metricsAnomalyRows(envelope),
      );
      return;
    }
    sendCsv(
      res,
      'metrics-series.csv',
      ['scope', 'key', 'metric', 't', 'v'],
      metricsSeriesRows(envelope),
    );
  });

  return router;
}

export const metricsRouter = createMetricsRouter();
