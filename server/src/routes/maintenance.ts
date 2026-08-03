/**
 * server/src/routes/maintenance.ts — maintenance-window CRUD.
 *
 *   GET    /api/maintenance-windows        every window on file (expired flagged, span state
 * *                                         annotated) + the authored fixtures in demo mode
 *   POST   /api/maintenance-windows        {reason, matchers, schedule, enabled?} → 201
 *   PATCH  /api/maintenance-windows/:id    {enabled} → {window} | 404
 *   DELETE /api/maintenance-windows/:id    remove one → {ok, window} | 404
 *
 * A window is NOT a brokered write: nothing is pushed to a plane, it only
 * schedules what the portal's own queue hushes. So there is no ticket gate —
 * but every mutation is an operator action and is audit-logged through the
 * same append-only change log as the silences it materializes
 * (services/maintenance.ts logMaintenanceEvent).
 *
 * Validation refuses rather than repairs, mirroring the silence route: a
 * reason is required and capped (MAX_SILENCE_REASON_CHARS — the reason is
 * stamped on every silence the window raises, so the same limit rules); at
 * least one silence-expressible matcher (plane, device or titleSubstring) is
 * required — a site-only window could never materialize a silence, and a
 * matcher-less one would hush the whole queue on a schedule; one-shot windows
 * need start < end; weekly windows need named weekdays and a startTime that
 * differs from endTime (equal times read as zero-length or 24 hours depending
 * on who is looking, and a schedule nobody can agree on is not a schedule).
 */

import { Router } from 'express';
import {
  DEMO_MAINTENANCE_WINDOWS,
  isValidTimeZone,
  MAX_SILENCE_REASON_CHARS,
  parseTimeHHMM,
  windowSpanAt,
  type MaintenanceMatchers,
  type MaintenanceSchedule,
  type MaintenanceWindow,
  type MaintenanceWindowView,
} from '@hpe/shared';
import { h } from './handler';
import { settings } from '../config/settings';
import { currentActor } from '../services/auth';
import { logMaintenanceEvent, maintenanceStore } from '../services/maintenance';
import { brokerDataDir } from '../services/writeBroker';

export const maintenanceRouter = Router();

/** The persisted window plus where it stands right now. */
function annotate(window: MaintenanceWindow, now: number, demo?: true): MaintenanceWindowView {
  const at = windowSpanAt(window, now);
  return {
    ...window,
    state: at.state,
    ...(at.state === 'expired' ? { expired: true } : { spanStart: new Date(at.span.start).toISOString(), spanEnd: new Date(at.span.end).toISOString() }),
    ...(demo ? { demo } : {}),
  };
}

maintenanceRouter.get(
  '/maintenance-windows',
  h(async (_req, res) => {
    const now = Date.now();
    const windows = maintenanceStore.list(now).map((w) => annotate(w, now));
    // The authored fixtures are served labelled, alongside the real rows —
    // the demo must show the feature, and a fixture must never read as an
    // operator's window.
    if (settings.get().demoMode) {
      windows.push(...DEMO_MAINTENANCE_WINDOWS.map((w) => annotate(w, now, true)));
    }
    res.json({ windows });
  }),
);

/** Body → validated matchers, or the 400 message. Matchers are trimmed, never
 *  repaired beyond that. */
function readMatchers(raw: unknown): { matchers: MaintenanceMatchers } | { error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const plane = typeof body.plane === 'string' ? body.plane.trim() : '';
  const device = typeof body.device === 'string' ? body.device.trim() : '';
  const site = typeof body.site === 'string' ? body.site.trim() : '';
  const titleSubstring = typeof body.titleSubstring === 'string' ? body.titleSubstring.trim() : '';
  if (!plane && !device && !titleSubstring) {
    return {
      error:
        'at least one of plane, device or titleSubstring is required — a silence can only match those, ' +
        'so a window without them hushes nothing (site narrows a matcher, it cannot stand alone)',
    };
  }
  return {
    matchers: {
      ...(plane ? { plane } : {}),
      ...(device ? { device } : {}),
      ...(site ? { site } : {}),
      ...(titleSubstring ? { titleSubstring } : {}),
    },
  };
}

/** Body → validated schedule, or the 400 message. */
function readSchedule(raw: unknown): { schedule: MaintenanceSchedule } | { error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (body.kind === 'once') {
    const start = typeof body.start === 'string' ? Date.parse(body.start) : NaN;
    const end = typeof body.end === 'string' ? Date.parse(body.end) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return { error: "a 'once' window needs ISO start and end instants" };
    }
    if (end <= start) {
      return { error: 'a window must end after it starts — an empty span hushes nothing' };
    }
    return { schedule: { kind: 'once', start: new Date(start).toISOString(), end: new Date(end).toISOString() } };
  }
  if (body.kind === 'weekly') {
    const days = Array.isArray(body.days) ? body.days.filter((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) : [];
    if (days.length === 0) {
      return { error: 'a weekly window needs at least one weekday (0=Sunday … 6=Saturday)' };
    }
    const startTime = typeof body.startTime === 'string' ? body.startTime.trim() : '';
    const endTime = typeof body.endTime === 'string' ? body.endTime.trim() : '';
    const startMin = parseTimeHHMM(startTime);
    const endMin = parseTimeHHMM(endTime);
    if (startMin === null || endMin === null) {
      return { error: "weekly startTime/endTime must be 'HH:MM' 24-hour wall time" };
    }
    if (startMin === endMin) {
      return { error: 'startTime and endTime are the same — a window must have a length (an overnight span ends the next day, e.g. 22:00 → 02:00)' };
    }
    const tz = typeof body.tz === 'string' && body.tz.trim() ? body.tz.trim() : undefined;
    if (tz && !isValidTimeZone(tz)) {
      return { error: `unknown time zone '${tz}' — use an IANA name like 'Europe/London', or omit it for the server's local zone` };
    }
    return { schedule: { kind: 'weekly', days: [...new Set(days as number[])].sort(), startTime, endTime, ...(tz ? { tz } : {}) } };
  }
  return { error: "schedule.kind must be 'once' or 'weekly' — RRULE-lite, nothing more" };
}

maintenanceRouter.post(
  '/maintenance-windows',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      res.status(400).json({ error: 'reason required — a window with no reason is a hush nobody can explain' });
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
    const matchers = readMatchers(body.matchers);
    if ('error' in matchers) {
      res.status(400).json(matchers);
      return;
    }
    const schedule = readSchedule(body.schedule);
    if ('error' in schedule) {
      res.status(400).json(schedule);
      return;
    }
    const window = maintenanceStore.create({
      reason,
      matchers: matchers.matchers,
      schedule: schedule.schedule,
      enabled: body.enabled !== false,
      createdBy: currentActor(),
    });
    logMaintenanceEvent(brokerDataDir(), window, `created — ${window.reason}`);
    res.status(201).json({ window });
  }),
);

maintenanceRouter.patch(
  '/maintenance-windows/:id',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) required — that is the only thing a patch changes' });
      return;
    }
    const window = maintenanceStore.setEnabled(req.params.id, body.enabled);
    if (!window) {
      res.status(404).json({ error: `unknown maintenance window '${req.params.id}'` });
      return;
    }
    logMaintenanceEvent(brokerDataDir(), window, `${body.enabled ? 'enabled' : 'disabled'} — ${window.reason}`);
    res.json({ window });
  }),
);

maintenanceRouter.delete(
  '/maintenance-windows/:id',
  h(async (req, res) => {
    const removed = maintenanceStore.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: `unknown maintenance window '${req.params.id}'` });
      return;
    }
    logMaintenanceEvent(brokerDataDir(), removed, `deleted — ${removed.reason}`);
    res.json({ ok: true, window: removed });
  }),
);
