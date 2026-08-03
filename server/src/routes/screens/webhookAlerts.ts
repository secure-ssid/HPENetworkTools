/**
 * server/src/routes/screens/webhookAlerts.ts — received-webhook alerts in the
 * queue views.
 *
 * Events the webhook receiver accepted (services/webhookReceiver.ts) are
 * REAL inbound data — like raised tickets and silences, they surface in
 * every mode, demo included: hushing or grouping the demo queue while
 * ignoring an event the portal actually received would be the demo lying
 * about the feature. This helper is the single additive seam: it prepends
 * the received events (projected to AlertRow at read time, source
 * 'webhook', plane set to the delivering plane) to whatever rows a screen
 * route already had, so the result flows through the SAME alertQueueView
 * fingerprint/group/silence path as every other row. Newest deliveries lead,
 * exactly like raised tickets lead the ticket queue.
 */

import type { AlertRow } from '@hpe/shared';
import { webhookReceiver, type WebhookReceiver } from '../../services/webhookReceiver';

/** The route's alert rows plus every received webhook event on record. */
export function withWebhookAlerts(
  rows: AlertRow[],
  receiver: WebhookReceiver = webhookReceiver,
  nowMs: number = Date.now(),
): AlertRow[] {
  const received = receiver.recentAlertRows(nowMs);
  if (received.length === 0) return rows;
  return [...received, ...rows];
}
