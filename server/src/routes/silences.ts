/**
 * server/src/routes/silences.ts — alert-silence CRUD.
 *
 *   GET    /api/silences          every silence on file, expired flagged
 *   POST   /api/silences          {plane?, device?, titleContains?, reason, durationMinutes} → 201
 *   DELETE /api/silences/:id      remove one (unsilence) → {ok, silence} | 404
 *
 * A silence is NOT a brokered write: nothing is pushed to a plane, it only
 * changes what the portal's own queue shows. So there is no ticket gate —
 * but creation and removal are operator actions and are audit-logged
 * through the same append-only change log as the brokered writes
 * (services/silences.ts logSilenceEvent).
 *
 * Validation refuses rather than repairs: a reason is required and
 * over-length reasons are 400 (never truncated — MAX_SILENCE_REASON_CHARS),
 * the duration must be a positive number of minutes no longer than
 * MAX_SILENCE_DURATION_MINUTES (silences are time-boxed by design), and at
 * least one matcher must be set, because a silence matching everything
 * would hush the whole queue.
 */

import { Router } from 'express';
import { MAX_SILENCE_DURATION_MINUTES, MAX_SILENCE_REASON_CHARS, type AlertSilence } from '@hpe/shared';
import { h } from './handler';
import { logSilenceEvent, silenceStore } from '../services/silences';
import { brokerDataDir } from '../services/writeBroker';

export const silencesRouter = Router();

silencesRouter.get(
  '/silences',
  h(async (_req, res) => {
    res.json({ silences: silenceStore.list() });
  }),
);

silencesRouter.post(
  '/silences',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      res.status(400).json({ error: 'reason required — a silence with no reason is a hush nobody can explain' });
      return;
    }
    if (reason.length > MAX_SILENCE_REASON_CHARS) {
      res.status(400).json({
        error:
          `reason is ${reason.length} characters — the limit is ${MAX_SILENCE_REASON_CHARS}. ` +
          'Nothing was saved; shorten it and send again. The portal refuses an over-length reason rather than filing a truncated one.',
      });
      return;
    }
    const durationMinutes = typeof body.durationMinutes === 'number' ? body.durationMinutes : NaN;
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > MAX_SILENCE_DURATION_MINUTES) {
      res.status(400).json({
        error: `durationMinutes must be a positive number no larger than ${MAX_SILENCE_DURATION_MINUTES} (90 days) — silences are time-boxed`,
      });
      return;
    }
    const plane = typeof body.plane === 'string' ? body.plane.trim() : '';
    const device = typeof body.device === 'string' ? body.device.trim() : '';
    const titleContains = typeof body.titleContains === 'string' ? body.titleContains.trim() : '';
    if (!plane && !device && !titleContains) {
      res.status(400).json({
        error: 'at least one matcher (plane, device or titleContains) is required — a silence that matches everything would hush the whole queue',
      });
      return;
    }
    const silence = silenceStore.create({
      ...(plane ? { plane } : {}),
      ...(device ? { device } : {}),
      ...(titleContains ? { titleContains } : {}),
      reason,
      durationMinutes,
    });
    logSilenceEvent(
      brokerDataDir(),
      'alert-silence',
      silence,
      `until ${silence.until} — ${silence.reason}`,
    );
    res.status(201).json({ silence });
  }),
);

silencesRouter.delete(
  '/silences/:id',
  h(async (req, res) => {
    const removed: AlertSilence | null = silenceStore.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: `unknown silence '${req.params.id}'` });
      return;
    }
    logSilenceEvent(brokerDataDir(), 'alert-unsilence', removed, `removed — ${removed.reason}`);
    res.json({ ok: true, silence: removed });
  }),
);
