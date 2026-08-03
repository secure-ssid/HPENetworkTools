/**
 * shared/alertEngine.ts — alert dedup, grouping, and time-boxed silences.
 *
 * The 12-plane alert feed has no noise control of its own: correlateAlerts
 * (logic.ts) narrates the queue, but nothing collapses a flapping alert that
 * fires forty times into one row, and nothing lets an operator hush a known
 * problem while it is being worked. This module is the pure half of that —
 * no I/O, no clock beyond the `now` a caller hands in, so the server route
 * and the browser screen can group and silence the SAME queue the same way.
 *
 * The model follows Alertmanager:
 *
 *   - FINGERPRINT. An alert's identity is its normalised plane+device+title.
 *     Two rows that only differ in age or detail are two firings of the same
 *     problem and render as one group with a count. The plane's own key
 *     (alertId) is deliberately NOT part of it: Central hands a flapping
 *     alert a fresh key per firing, and keying on it would never dedupe.
 *
 *   - GROUP. { fingerprint, latest, count, firstSeen, lastSeen } — the latest
 *     firing stands for the group (it is what an operator acts on), the count
 *     carries the noise level, and first/last seen bracket the storm in the
 *     queue's own age vocabulary ('12m').
 *
 *   - SILENCE. A time-boxed suppression: an optional plane, an optional
 *     device, and an optional title substring, matched case-insensitively;
 *     every given matcher must hold. A silence that names NOTHING matches
 *     nothing — a criterion-less silence would hush the whole queue, which is
 *     exactly the failure the required-matcher rule exists to prevent. It is
 *     active strictly while now < until; an unparseable `until` is inactive,
 *     never a permanent hush.
 *
 * Suppression is a presentation fact, never a deletion: partitionAlertGroups
 * hands the silenced groups back WITH their silence, because the screen must
 * always show what was hushed and why — an invisible silence is a quiet
 * estate that is not quiet.
 */

import { alertAgeMinutes } from './logic';
import type { AlertRow } from './types';

/**
 * The longest reason a silence accepts. Shared so the browser warns against
 * exactly the number the server enforces — same rule as MAX_NOTE_CHARS for
 * ticket notes. Over-length reasons are refused, never truncated: half a
 * justification filed as though it were whole is the record looking complete
 * when it is not.
 */
export const MAX_SILENCE_REASON_CHARS = 500;

/** The longest a silence may run: 90 days in minutes. Silences are
 *  TIME-BOXED by design — an open-ended hush is how a queue goes quietly
 *  dark. The bound also catches a minutes/hours typo before it benches a
 *  firing for years. */
export const MAX_SILENCE_DURATION_MINUTES = 90 * 24 * 60;

/** The identity of an alert firing: normalised plane+device+title. */
export type AlertFingerprint = string;

/** A time-boxed suppression rule, as persisted in data/silences.json. */
export interface AlertSilence {
  id: string;
  /** Optional matchers — at least one is set (the route refuses otherwise). */
  plane?: string;
  device?: string;
  titleContains?: string;
  /** Why the queue is being hushed. Required; shown wherever the group is
   *  hidden from, and audit-logged at creation. */
  reason: string;
  createdAt: string; // ISO
  /** ISO instant the silence stops applying. Active strictly before it. */
  until: string;
  /**
   * Derived on READ, never persisted: true once `until` has passed. An
   * expired silence stops matching but stays listed — it is a record that an
   * operator hushed the queue, and expiring must not quietly erase that.
   */
  expired?: boolean;
}

/** One deduplicated entry of the alert queue. */
export interface AlertGroup {
  fingerprint: AlertFingerprint;
  /** The most recent firing — the row the group renders and acts on. */
  latest: AlertRow;
  /** How many firings the group stands for. */
  count: number;
  /** Age string of the OLDEST firing (when the storm started), e.g. '6h'. */
  firstSeen: string;
  /** Age string of the newest firing, e.g. '12m'. */
  lastSeen: string;
}

/** A group kept out of the active queue, WITH the silence that did it. */
export interface SilencedAlertGroup {
  group: AlertGroup;
  silence: AlertSilence;
}

/** Lowercase, trimmed, runs of whitespace collapsed — the fingerprint's idea
 *  of "the same" plane, device or title. */
function normKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The dedup key for one firing. Normalised so 'Config Out of Sync' and
 *  '  config out of SYNC ' land in one group, as one problem should. */
export function alertFingerprint(alert: Pick<AlertRow, 'plane' | 'device' | 'title'>): AlertFingerprint {
  return [alert.plane, alert.device, alert.title].map(normKey).join('|');
}

/**
 * Collapse a queue into deduped groups. Groups appear in the order their
 * first firing appeared in the input — a caller that wants the queue's
 * severity order sorts the rows first (the live route already does), and the
 * authored demo queue keeps its authored order either way.
 *
 * `latest` is the firing with the SMALLEST age (most recent); first/last
 * seen are the two age strings that bracket the group. An age string the
 * parser does not recognise reads as brand new (alertAgeMinutes' own rule),
 * so it sorts as the latest firing rather than as ancient history.
 */
export function groupAlerts(rows: readonly AlertRow[]): AlertGroup[] {
  const groups = new Map<AlertFingerprint, { latest: AlertRow; oldest: AlertRow; count: number }>();
  for (const row of rows) {
    const fingerprint = alertFingerprint(row);
    const cur = groups.get(fingerprint);
    if (!cur) {
      groups.set(fingerprint, { latest: row, oldest: row, count: 1 });
      continue;
    }
    cur.count += 1;
    if (alertAgeMinutes(row.age) < alertAgeMinutes(cur.latest.age)) cur.latest = row;
    if (alertAgeMinutes(row.age) > alertAgeMinutes(cur.oldest.age)) cur.oldest = row;
  }
  return [...groups.entries()].map(([fingerprint, g]) => ({
    fingerprint,
    latest: g.latest,
    count: g.count,
    firstSeen: g.oldest.age,
    lastSeen: g.latest.age,
  }));
}

/**
 * Does a silence cover this firing? Every matcher the silence SETS must
 * hold (AND): plane and device compare exactly after normalisation, the
 * title matcher is a case-insensitive substring. A silence with no matchers
 * set matches NOTHING — the route refuses to create one, and this function
 * is the second line of defence.
 */
export function silenceMatches(
  silence: Pick<AlertSilence, 'plane' | 'device' | 'titleContains'>,
  alert: Pick<AlertRow, 'plane' | 'device' | 'title'>,
): boolean {
  const plane = silence.plane?.trim();
  const device = silence.device?.trim();
  const title = silence.titleContains?.trim();
  if (!plane && !device && !title) return false;
  if (plane && normKey(plane) !== normKey(alert.plane)) return false;
  if (device && normKey(device) !== normKey(alert.device)) return false;
  if (title && !normKey(alert.title).includes(normKey(title))) return false;
  return true;
}

/**
 * A silence applies strictly while now < until. An `until` that will not
 * parse is INACTIVE: a malformed clock is not a licence to hush the queue
 * forever.
 */
export function silenceIsActive(silence: Pick<AlertSilence, 'until'>, now: number = Date.now()): boolean {
  const until = Date.parse(silence.until);
  return Number.isFinite(until) && now < until;
}

/**
 * Split grouped alerts into the active queue and the silenced bench. Every
 * firing in a group shares its fingerprint's plane+device+title, so matching
 * the group's `latest` matches the whole group. The FIRST active silence
 * that matches wins the `silence` slot — its reason is the one shown.
 * Expired silences are ignored here; the store still lists them.
 */
export function partitionAlertGroups(
  groups: readonly AlertGroup[],
  silences: readonly AlertSilence[],
  now: number = Date.now(),
): { active: AlertGroup[]; silenced: SilencedAlertGroup[] } {
  const live = silences.filter((s) => silenceIsActive(s, now));
  const active: AlertGroup[] = [];
  const silenced: SilencedAlertGroup[] = [];
  for (const group of groups) {
    const hit = live.find((s) => silenceMatches(s, group.latest));
    if (hit) silenced.push({ group, silence: hit });
    else active.push(group);
  }
  return { active, silenced };
}
