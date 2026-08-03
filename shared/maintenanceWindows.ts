/**
 * shared/maintenanceWindows.ts — scheduled maintenance windows.
 *
 * A maintenance window is a NAMED, SCHEDULED suppression rule: where a silence
 * (shared/alertEngine.ts) is an ad-hoc "hush this for 8 hours", a window is the
 * recurring or one-off calendar entry the silence is raised for — "AP firmware
 * staging, every night 00:00–06:00", "ISP cutover Aug 3 02:00–04:00". The
 * server materializes each window into an ordinary silence while it is active
 * (server/src/services/maintenance.ts), so suppression, expiry and the
 * silenced-group listing all run through the ONE existing mechanism rather
 * than a second shadow implementation.
 *
 * This module is the pure half — no I/O, no clock beyond the `now` a caller
 * hands in — so the server scheduler, the routes and the browser screen all
 * agree on when a window is active, what its next span is, and which alerts it
 * covers. The schedule vocabulary is deliberately RRULE-lite: one-shot
 * ('once') and same-time-every-week ('weekly'), nothing more. Weekly spans may
 * cross midnight (22:00–02:00 means "starts at 22:00, ends the next day") —
 * maintenance is when the estate is quiet, which is usually overnight.
 *
 * Matchers mirror the silence model (plane / device / title substring, all
 * case-insensitive, every set matcher must hold) plus a `site` matcher the
 * silence format cannot express; the materialized silence carries it through
 * and the queue view narrows by it (server/src/services/silences.ts). A window
 * with NO matchers matches nothing — the route refuses to create one, and
 * windowMatchesAlert is the second line of defence.
 */

import { alertFingerprint } from './alertEngine';
import type { AlertRow } from './types';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** What a window hushes. Every set matcher must hold (AND); `site` compares
 *  against the alert's siteName OR siteId. At least one of plane, device or
 *  titleSubstring is required by the route — site alone cannot materialize a
 *  silence, because the silence format has no site key of its own. */
export interface MaintenanceMatchers {
  plane?: string;
  device?: string;
  site?: string;
  titleSubstring?: string;
}

/** A one-off span: absolute ISO start and end, start < end. */
export interface OnceSchedule {
  kind: 'once';
  start: string; // ISO instant
  end: string; // ISO instant
}

/**
 * Same wall-clock span on named weekdays, recurring forever. `days` holds
 * 0=Sunday..6=Saturday; startTime/endTime are 'HH:MM' 24-hour wall time in
 * `tz` (an IANA zone name; absent = the server's local zone). endTime earlier
 * than startTime means the span ends the FOLLOWING day. endTime equal to
 * startTime is refused — it would read as either zero-length or 24 hours, and
 * a schedule nobody can agree on is not a schedule.
 */
export interface WeeklySchedule {
  kind: 'weekly';
  days: number[];
  startTime: string; // 'HH:MM'
  endTime: string; // 'HH:MM'
  tz?: string;
}

export type MaintenanceSchedule = OnceSchedule | WeeklySchedule;

/** A scheduled suppression rule, as persisted in data/maintenance-windows.json. */
export interface MaintenanceWindow {
  id: string;
  /** Why the estate is being hushed — required, audit-logged, and stamped on
   *  every silence the window materializes. */
  reason: string;
  matchers: MaintenanceMatchers;
  schedule: MaintenanceSchedule;
  enabled: boolean;
  createdBy: string;
  createdAt: string; // ISO
  /**
   * Derived on READ, never persisted: a one-shot window whose end has passed.
   * Expired windows stay on file — they are the record that suppression was
   * scheduled, and the calendar turning over must not erase that record (the
   * same rule expired silences follow).
   */
  expired?: boolean;
  /**
   * ISO start of the span the scheduler last materialized a silence for.
   * Stamped by the scheduler so a restart never raises a second silence for
   * the same occurrence — and so an operator who deletes the materialized
   * silence (an override for the rest of the occurrence) is not immediately
   * re-silenced by the next tick.
   */
  lastMaterialized?: string;
}

/** One concrete occurrence of a window, as epoch milliseconds: [start, end). */
export interface WindowSpan {
  start: number;
  end: number;
}

/**
 * Where a window stands at `now`: inside a span ('active'), with its next
 * span known ('upcoming'), or finished for good ('expired' — one-shots whose
 * end has passed; a malformed schedule also lands here, doing nothing, which
 * is the honest answer for a window nobody can compute).
 */
export type WindowState =
  | { state: 'active'; span: WindowSpan }
  | { state: 'upcoming'; span: WindowSpan }
  | { state: 'expired' };

/** The /api/maintenance-windows row: the persisted window annotated with where
 *  it stands right now. `demo` marks an authored fixture (demo mode only) —
 *  fixtures are labelled, never passed off as an operator's window. */
export interface MaintenanceWindowView extends MaintenanceWindow {
  state: 'active' | 'upcoming' | 'expired';
  /** ISO bounds of the active/next span (absent when expired). */
  spanStart?: string;
  spanEnd?: string;
  demo?: true;
}

// ---------------------------------------------------------------------------
// Occurrence timeline (the alert drawer's per-group history)
// ---------------------------------------------------------------------------

/** One line of an alert group's occurrence timeline. */
export interface AlertTimelineEvent {
  ts: string; // ISO
  kind: 'fired' | 'silenced' | 'silence-expired' | 'change' | 'config-drift';
  label: string;
  detail?: string;
  /** True when `ts` was derived from the queue's age strings ('12m') — an
   *  approximation, shown as one. Authored/persisted facts carry exact times. */
  approximate?: boolean;
}

/**
 * Everything the portal knows about one alert fingerprint, oldest first:
 * firings from the queue, silences from the silence store, the device's
 * change-log lines and config-backup drift. `correlation` is the ONE
 * sanctioned cross-reference sentence ('N alerts fired within 30m after
 * change X') — a statement about times, never a causal claim.
 */
export interface AlertTimeline {
  fingerprint: string;
  device: string | null;
  events: AlertTimelineEvent[];
  correlation?: string;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/** The window matchers' idea of "the same" — the silence matcher's rule. */
function normKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 'HH:MM' 24-hour → minutes since midnight, or null for anything else. */
export function parseTimeHHMM(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Whether `tz` names a zone Intl can format in — the route's validation and
 *  the scheduler's guard share this rather than disagreeing about it. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// -- wall-clock <-> epoch in an optional zone -------------------------------
//
// Weekly windows are defined in WALL time ('Tue 02:00'), and wall time only
// has an epoch meaning through a zone. No date library is available (and none
// is added), so the two conversions below lean on Intl: wallPartsAt reads an
// instant as wall parts in the zone; epochForWall inverts it by iterating —
// guess the wall time as UTC, measure the drift, adjust. Three passes absorb
// any offset this planet uses, DST gaps included (a nonexistent wall time
// lands on the nearest real instant, which is the only sensible reading).

interface WallParts {
  year: number;
  month: number; // 1-based
  day: number;
  weekday: number; // 0=Sunday
  minutes: number; // since midnight
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz?: string): Intl.DateTimeFormat {
  const key = tz ?? '';
  let fmt = dtfCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(key, fmt);
  }
  return fmt;
}

function wallPartsAt(epoch: number, tz?: string): WallParts {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = 0;
  for (const part of zoneFormatter(tz).formatToParts(new Date(epoch))) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? 0;
  }
  return { year, month, day, weekday, minutes: hour * 60 + minute };
}

function epochForWall(year: number, month: number, day: number, minutes: number, tz?: string): number {
  const target = Date.UTC(year, month - 1, day, 0, minutes);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const actual = wallPartsAt(guess, tz);
    const drift = target - Date.UTC(actual.year, actual.month - 1, actual.day, 0, actual.minutes);
    if (drift === 0) return guess;
    guess += drift;
  }
  return guess;
}

/**
 * Where `window` stands at `now` — the active span, the next span, or
 * 'expired'. The weekly search walks yesterday through next week: yesterday's
 * overnight span may still be running, and any non-empty `days` set has an
 * occurrence within the week ahead.
 */
export function windowSpanAt(
  window: Pick<MaintenanceWindow, 'schedule'>,
  now: number = Date.now(),
): WindowState {
  const schedule = window.schedule;
  if (schedule.kind === 'once') {
    const start = Date.parse(schedule.start);
    const end = Date.parse(schedule.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || now >= end) {
      return { state: 'expired' };
    }
    return now >= start ? { state: 'active', span: { start, end } } : { state: 'upcoming', span: { start, end } };
  }
  const startMin = parseTimeHHMM(schedule.startTime);
  const endMin = parseTimeHHMM(schedule.endTime);
  if (startMin === null || endMin === null || startMin === endMin || schedule.days.length === 0) {
    return { state: 'expired' };
  }
  const at = wallPartsAt(now, schedule.tz);
  for (let offset = -1; offset <= 7; offset += 1) {
    const date = new Date(Date.UTC(at.year, at.month - 1, at.day + offset));
    if (!schedule.days.includes(date.getUTCDay())) continue;
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const start = epochForWall(year, month, day, startMin, schedule.tz);
    // endTime <= startTime means the span runs into the following day.
    const end = epochForWall(year, month, day + (endMin > startMin ? 0 : 1), endMin, schedule.tz);
    if (now >= start && now < end) return { state: 'active', span: { start, end } };
    if (now < start) return { state: 'upcoming', span: { start, end } };
  }
  return { state: 'expired' }; // unreachable for a valid weekly schedule
}

/**
 * The silence a window materializes into: the matchers the silence format can
 * express (titleSubstring → titleContains), with `site` carried through under
 * its own key — the queue view narrows by it even though the shared silence
 * matcher has no notion of sites (server/src/services/silences.ts).
 */
export function windowToSilenceMatcher(
  window: Pick<MaintenanceWindow, 'matchers'>,
): { plane?: string; device?: string; titleContains?: string; site?: string } {
  const { plane, device, site, titleSubstring } = window.matchers;
  return {
    ...(plane?.trim() ? { plane: plane.trim() } : {}),
    ...(device?.trim() ? { device: device.trim() } : {}),
    ...(titleSubstring?.trim() ? { titleContains: titleSubstring.trim() } : {}),
    ...(site?.trim() ? { site: site.trim() } : {}),
  };
}

/** Does a `site` matcher cover this alert? Compared against the row's
 *  siteName AND its siteId — an operator thinks in names, a feed in ids. */
export function maintenanceSiteMatches(site: string, alert: Pick<AlertRow, 'siteId' | 'siteName'>): boolean {
  const wanted = normKey(site);
  return normKey(alert.siteName) === wanted || normKey(alert.siteId) === wanted;
}

/**
 * Does a window cover this alert firing? Every matcher the window SETS must
 * hold; a window with none matches NOTHING (the route refuses those, and this
 * is the second line of defence — the same rule silences follow).
 */
export function windowMatchesAlert(
  window: Pick<MaintenanceWindow, 'matchers'>,
  alert: Pick<AlertRow, 'plane' | 'device' | 'title' | 'siteId' | 'siteName'>,
): boolean {
  const m = windowToSilenceMatcher(window);
  if (!m.plane && !m.device && !m.titleContains && !m.site) return false;
  if (m.plane && normKey(m.plane) !== normKey(alert.plane)) return false;
  if (m.device && normKey(m.device) !== normKey(alert.device)) return false;
  if (m.titleContains && !normKey(alert.title).includes(normKey(m.titleContains))) return false;
  if (m.site && !maintenanceSiteMatches(m.site, alert)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Demo fixtures — authored, labelled, and timeless
// ---------------------------------------------------------------------------

/**
 * The authored demo windows, served by GET /api/maintenance-windows alongside
 * the operator's real ones whenever the portal is in demo mode (marked
 * `demo: true` there, and never writable through the API — they are not in
 * the store).
 *
 * `mw-demo-ap3f` runs around the clock so the showcase — the flapping 3rd-
 * floor AP benched from the demo queue under "maintenance window" — holds
 * whenever the demo is opened. Its suppression is VIRTUAL (computed on read
 * while the scheduler runs in demo mode): fixtures never write to the
 * operator's silence store or audit log.
 *
 * `mw-demo-firmware` is the Saturday 02:00–04:00 window the demo queue's own
 * '6 CX switches still on 10.11 firmware' row already names — mostly it is
 * UPCOMING, which is the other state the section must show.
 */
export const DEMO_MAINTENANCE_WINDOWS: MaintenanceWindow[] = [
  {
    id: 'mw-demo-ap3f',
    reason: 'AP firmware staging — 3rd-floor-east radios reset on DFS events until the 10.13 upgrade',
    matchers: { device: 'ap-3f-12', site: 'Campus-02 Research' },
    schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:59' },
    enabled: true,
    createdBy: 'demo fixture',
    createdAt: '2026-07-01T09:00:00.000Z',
  },
  {
    id: 'mw-demo-firmware',
    reason: 'CX firmware 10.13.1005 rollout — six access switches',
    matchers: { plane: 'LOCAL', titleSubstring: 'firmware' },
    schedule: { kind: 'weekly', days: [6], startTime: '02:00', endTime: '04:00' },
    enabled: true,
    createdBy: 'demo fixture',
    createdAt: '2026-07-20T09:00:00.000Z',
  },
];

/** The fingerprint of the demo queue's flapping-AP group — the group whose
 *  drawer carries the authored occurrence timeline. */
export const DEMO_TIMELINE_FINGERPRINT = alertFingerprint({
  plane: 'MIST',
  device: 'ap-3f-12',
  title: 'Wi-Fi drops, 3rd floor east — 22 clients',
});

/**
 * The authored occurrence timeline for the demo queue's flapping AP: fired →
 * deduped ×23 → silenced by the maintenance window → the change that frames
 * it. Times are relative to `now` so the demo never ages; the correlation
 * sentence is exactly the one sanctioned shape — a statement about times,
 * never a causal claim. Null for any other fingerprint.
 */
export function demoAlertTimeline(
  fingerprint: string,
  now: number = Date.now(),
): Pick<AlertTimeline, 'events' | 'correlation'> | null {
  if (fingerprint !== DEMO_TIMELINE_FINGERPRINT) return null;
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return {
    events: [
      {
        ts: ago(132),
        kind: 'change',
        label: 'Change committed — SSID profile push to Campus-02 Research',
        detail: 'chg-demo-4148 · ticket NET-4188 · demo fixture',
      },
      {
        ts: ago(125),
        kind: 'fired',
        label: 'First firing — Wi-Fi drops, 3rd floor east (22 clients)',
        detail: 'MIST · ap-3f-12 · demo fixture',
      },
      {
        ts: ago(110),
        kind: 'fired',
        label: 'Repeat firings deduped ×23 — radios resetting on DFS radar events',
        detail: 'one group in the queue, not 23 rows · demo fixture',
      },
      {
        ts: ago(90),
        kind: 'silenced',
        label: 'Silenced by maintenance window — AP firmware staging, 3rd-floor-east radios',
        detail: 'mw-demo-ap3f · demo fixture',
      },
      {
        ts: ago(45),
        kind: 'config-drift',
        label: 'Config drift — sw-acc-3f-2 v3 stored (uplink of ap-3f-12)',
        detail: 'demo synthesis · demo fixture',
      },
    ],
    correlation:
      '23 alerts fired within 30m after change chg-demo-4148 — a correlation in time, not a proven cause',
  };
}
