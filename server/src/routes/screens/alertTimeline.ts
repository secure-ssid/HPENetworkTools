/**
 * server/src/routes/screens/alertTimeline.ts — the per-group occurrence timeline.
 *
 * One alert group (fingerprint = normalised plane+device+title) has a history
 * scattered across stores that already persist their own facts. This helper
 * joins them, adds nothing of its own, and serves the join oldest-first:
 *
 *   - FIRINGS from the current queue (shared/alertEngine groups) — the
 *     timestamps are derived from the queue's age strings, so they are marked
 *     `approximate`: '12m ago' is not a clock reading.
 *   - SILENCES from the silence store, expired ones included — a hush and its
 *     expiry are both events in the group's life. Window-materialized
 *     silences say which maintenance window raised them.
 *   - CHANGES from the broker audit log (data/change-log.jsonl, through the
 *     writeBroker reader so rotated generations and unreadable lines behave
 *     exactly as they do for the Configure history drawer) — the lines that
 *     name the group's device. Silence audit lines are excluded (the store
 *     above already tells that story) and config-backup lines too (the
 *     backup service tells it better).
 *   - CONFIG DRIFT from the config-backup service: versions of the device's
 *     running-config that differ from their predecessor.
 *
 * In demo mode the flapping-AP fingerprint carries an AUTHORED spine
 * (shared/maintenanceWindows.ts demoAlertTimeline) so the drawer showcases
 * the join without credentials; real facts join it (an operator's demo-mode
 * silence is real data). The one cross-reference the payload allows itself is
 * `correlation` — 'N alerts fired within 30m after change X', a statement
 * about times, never a causal claim.
 */

import {
  ALERTS,
  alertAgeMinutes,
  alertFingerprint,
  demoAlertTimeline,
  groupAlerts,
  maintenanceSiteMatches,
  silenceMatches,
  type AlertRow,
  type AlertTimeline,
  type AlertTimelineEvent,
} from '@hpe/shared';
import { silenceStore } from '../../services/silences';
import { writeBroker, type BrokerEventRow } from '../../services/writeBroker';
import { configBackups } from '../../services/configBackup';
import { blendFor, blendSection, sourceFor } from './context';
import { liveAlerts, sortLiveAlerts } from './liveCore';

/** How many change-log lines the join scans — the same tail the Configure
 *  history drawer reads, so the timeline costs no more than that drawer. */
const CHANGE_SCAN_LIMIT = 200;
/** Caps per source so one noisy device cannot bury the rest of the story. */
const CHANGE_EVENT_LIMIT = 10;
const DRIFT_EVENT_LIMIT = 10;
/** The window after a change during which firings count toward the one
 *  sanctioned correlation sentence. */
const CORRELATION_WINDOW_MS = 30 * 60_000;

/** The audit-log rows carry device/who beyond the BrokerEventRow core — the
 *  reader parses whole JSON lines, so the fields are there to read. */
type DeviceLogRow = BrokerEventRow & { device?: string; who?: string };

/** The rows the /api/alerts handler would serve — demo fixtures, a blended
 *  swap, or the live queue — so a timeline always belongs to a group the
 *  operator can actually see. */
function currentAlertRows(): AlertRow[] {
  if (sourceFor('alerts') === 'demo') {
    if (blendFor('alerts')) {
      const blended: string[] = [];
      return blendSection('alerts', sortLiveAlerts(liveAlerts()), ALERTS, blended);
    }
    return [...ALERTS];
  }
  return sortLiveAlerts(liveAlerts());
}

/** The plane/device/title a fingerprint stands for. Parts are already
 *  normalised (lowercase, whitespace-collapsed) — which is exactly what the
 *  silence matcher compares, so a reconstructed row matches like a live one. */
function rowFromFingerprint(fingerprint: string): Pick<AlertRow, 'plane' | 'device' | 'title'> {
  const [plane = '', device = '', ...rest] = fingerprint.split('|');
  // The plane half is a display string here, not a plane-registry lookup —
  // the silence matcher only normalises and compares it.
  return { plane: plane as AlertRow['plane'], device, title: rest.join('|') };
}

/**
 * The join. Null when the fingerprint is unknown AND no store holds anything
 * for it — the route turns that into a 404 rather than an empty timeline
 * that would read as "nothing ever happened here".
 */
export function alertTimelineFor(fingerprint: string, now: number = Date.now()): AlertTimeline | null {
  if (!fingerprint.trim()) return null;
  const rows = currentAlertRows();
  const firings = rows.filter((row) => alertFingerprint(row) === fingerprint);
  const group = groupAlerts(firings).find((g) => g.fingerprint === fingerprint) ?? null;
  const device = group?.latest.device ?? rowFromFingerprint(fingerprint).device ?? null;

  const events: AlertTimelineEvent[] = [];

  // -- firings (approximate times — ages, not clock readings) --------------
  if (group) {
    events.push({
      ts: new Date(now - alertAgeMinutes(group.firstSeen) * 60_000).toISOString(),
      kind: 'fired',
      approximate: true,
      label:
        group.count > 1
          ? `Fired ×${group.count} — first seen ${group.firstSeen} ago, latest ${group.lastSeen} ago`
          : `Fired ${group.lastSeen} ago — ${group.latest.state}`,
      detail: `${group.latest.plane} · ${group.latest.device}`,
    });
  }

  // -- silences, expired ones included (they are the hush's history) --------
  const reference = group?.latest ?? rowFromFingerprint(fingerprint);
  const silences = silenceStore.list(now).filter((s) => {
    if (!silenceMatches(s, reference)) return false;
    // A site-scoped silence can only be confirmed against a firing row (it
    // carries the siteName); against a reconstructed one, exclude it rather
    // than claim a hush that may never have applied.
    if (s.site && (!group || !maintenanceSiteMatches(s.site, group.latest))) return false;
    return true;
  });
  for (const silence of silences) {
    events.push({
      ts: silence.createdAt,
      kind: 'silenced',
      label: `Silenced — ${silence.reason}`,
      detail: silence.windowId ? `maintenance window ${silence.windowId}` : `until ${silence.until}`,
    });
    const until = Date.parse(silence.until);
    if (Number.isFinite(until) && until <= now) {
      events.push({ ts: silence.until, kind: 'silence-expired', label: `Silence expired — ${silence.reason}` });
    }
  }

  // -- the device's change-log lines and config drift -----------------------
  const anchors: Array<{ ts: number; changeId: string }> = [];
  if (device && device !== '—') {
    const wanted = device.trim().toLowerCase();
    const read = writeBroker.readRecentEvents(CHANGE_SCAN_LIMIT);
    let taken = 0;
    for (const entry of read.events as DeviceLogRow[]) {
      if (taken >= CHANGE_EVENT_LIMIT) break;
      if (entry.event === 'alert-silence' || entry.event === 'alert-unsilence' || entry.event === 'config-backup') continue;
      if (!entry.device || entry.device.trim().toLowerCase() !== wanted) continue;
      events.push({
        ts: entry.ts,
        kind: 'change',
        label: `${entry.event} — ${entry.result}`,
        detail: `change ${entry.changeId} · ticket ${entry.ticket}${entry.who ? ` · ${entry.who}` : ''}`,
      });
      const at = Date.parse(entry.ts);
      if (Number.isFinite(at)) anchors.push({ ts: at, changeId: entry.changeId });
      taken += 1;
    }
    const drift = configBackups
      .listVersions(device)
      .filter((v) => v.driftFromPrevious)
      .slice(0, DRIFT_EVENT_LIMIT);
    for (const version of drift) {
      events.push({
        ts: version.takenAt,
        kind: 'config-drift',
        label: `Config drift — v${version.version} stored (${version.source})`,
        detail: `${device} · ${version.lines} lines`,
      });
      const at = Date.parse(version.takenAt);
      if (Number.isFinite(at)) anchors.push({ ts: at, changeId: `v${version.version}` });
    }
  }

  // -- the authored demo spine ----------------------------------------------
  const fixture = sourceFor('alerts') === 'demo' && !blendFor('alerts') ? demoAlertTimeline(fingerprint, now) : null;
  if (fixture) events.push(...fixture.events);

  if (!group && silences.length === 0 && events.length === 0) return null;

  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  // The ONE sanctioned cross-reference: firings within 30m after a change.
  // A statement about times — never that the change caused the firing.
  let correlation = fixture?.correlation;
  const firingTimes = firings.map((row) => now - alertAgeMinutes(row.age) * 60_000);
  anchors.sort((a, b) => b.ts - a.ts); // newest change first
  for (const anchor of anchors) {
    const n = firingTimes.filter((t) => t >= anchor.ts && t <= anchor.ts + CORRELATION_WINDOW_MS).length;
    if (n > 0) {
      correlation = `${n} alert${n === 1 ? '' : 's'} fired within 30m after change ${anchor.changeId} — a correlation in time, not a proven cause`;
      break; // the newest change with firings in its wake wins
    }
  }

  return { fingerprint, device, events, ...(correlation ? { correlation } : {}) };
}
