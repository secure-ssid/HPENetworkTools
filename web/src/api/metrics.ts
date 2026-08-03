/** Metrics history — GET /api/metrics (per-plane / per-device count series). */

import { hhmmLocal, type MetricsHistoryEnvelope } from '@hpe/shared';
import { fetchScreen } from './core';

/**
 * The count series behind the table sparklines. Additive: there is
 * deliberately NO fixture fallback — an unreachable or failing API hides the
 * sparkline column rather than painting authored history the server never
 * claimed. (Demo series are synthesized server-side; they are not part of
 * the offline fixture set — the getConfigBackups rule.)
 */
export async function getMetricsHistory(): Promise<MetricsHistoryEnvelope | null> {
  const result = await fetchScreen<MetricsHistoryEnvelope>('/api/metrics');
  return result.kind === 'ok' ? result.data : null;
}

/**
 * The honest window label every sparkline carries ("last 24h · sampled every
 * 5m", or "since 14:02 · …" while the ring is still filling after a server
 * start). Demo envelopes say the window is synthesized, here and in `note`.
 */
export function metricsWindowLabel(m: MetricsHistoryEnvelope, nowMs: number = Date.now()): string {
  const minutes = Math.max(1, Math.round(m.sampleMs / 60_000));
  const every = `sampled every ${minutes}m`;
  if (m.dataSource === 'demo') return `last 24h · ${every} · synthesized demo`;
  if (m.since === null) return every;
  const coveredMs = nowMs - Date.parse(m.since);
  if (!Number.isFinite(coveredMs) || coveredMs >= m.retentionMs * 0.95) {
    return `last 24h · ${every}`;
  }
  return `since ${hhmmLocal(m.since)} · ${every}`;
}
