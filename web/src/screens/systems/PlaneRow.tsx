/** The per-plane row on the Systems screen, and the small pieces it renders. */

import {
  type LivePlaneState,
  type LiveSyncEvent,
} from '../../api/client';
import { Badge } from '../../nightdesk';
import {
  PlaneView,
  codeTone,
  countFact,
  factValue,
  msFmt,
  staleTitle,
} from './facts';
import {
  type SyncHistoryRow,
  type SystemRow,
  type Tone,
  hhmmLocal as hhmm,
} from '@hpe/shared';

/**
 * A plane row in the dense table. One line per plane at a fixed row height so
 * ten planes read as a table rather than ten stacked cards; anything that does
 * not fit truncates with the full value kept in the cell's own title.
 */
export function PlaneRow({ view: v, onOpen }: { view: PlaneView; onOpen: (v: PlaneView) => void }) {
  const count = countFact(v.facts);
  const lastSync = factValue(v.facts, 'Last sync') ?? '—';
  const calls = factValue(v.facts, 'Calls today') ?? '—';
  const auth = factValue(v.facts, 'Token') ?? '—';
  return (
    <button
      type="button"
      role="row"
      className="nt-plane-row nt-plane-row--link"
      onClick={() => onOpen(v)}
    >
      <span role="cell" className="nt-plane-row__identity">
        <strong title={v.row.name}>{v.row.name}</strong>
        <small title={v.row.kind}>{v.row.kind}</small>
      </span>
      <span role="cell" className="nt-plane-row__status">
        <Badge tone={v.stateTone} dot>
          {v.stateLabel}
        </Badge>
        {/* The registry's own age-based flag, not a second opinion: a plane
            that is behind is marked here so its counts opposite are read as
            last-good, never as current. */}
        {v.live?.stale ? (
          <span title={staleTitle(v.live)}>
            <Badge tone="warning">unverified</Badge>
          </span>
        ) : null}
      </span>
      {/* `display: contents` on wide screens, so these four sit in the table's
          own columns; a wrapping labelled strip once the table collapses. */}
      <span className="nt-plane-row__facts">
        <span role="cell" className="nt-plane-row__cell" data-label="Last sync" title={lastSync}>
          {lastSync}
        </span>
        <span role="cell" className="nt-plane-row__cell nt-plane-row--num" data-label="Inventory">
          {count ? (
            <>
              {count.value}
              <small>{count.unit}</small>
            </>
          ) : (
            '—'
          )}
        </span>
        <span role="cell" className="nt-plane-row__cell nt-plane-row--num" data-label="Calls" title={calls}>
          {calls}
        </span>
        <span role="cell" className="nt-plane-row__cell" data-label="Auth" title={auth}>
          {auth}
        </span>
      </span>
      <span role="cell" className="nt-plane-row__scope">
        <Badge tone={v.row.scopeTone}>{v.row.scope}</Badge>
        <small title={v.row.scopeNote}>{v.row.scopeNote}</small>
      </span>
      <span role="cell" className="nt-plane-row__go" aria-hidden="true">
        ▸
      </span>
    </button>
  );
}

/**
 * The throttling banner (README §13) derived from the registry rather than
 * authored: a linked plane whose recent-call ring buffer holds 429s really is
 * being rate-limited, so name it and quote its own count. Everything else —
 * including an unlinked Classic that the portal has never called — gets no
 * banner at all.
 *
 * Every throttling plane is named. This used to stop at the first one in view
 * order, which made two different mistakes at once. Naming one of three read
 * as there being one, and view order is not severity, so a plane with a single
 * 429 in fifty calls could stand in front of one getting nothing through at
 * all. Both matter more here than for a single outage: 429s often share a
 * cause — a poll interval, a tenant quota — and a banner that shows one plane
 * at a time is a banner that hides the pattern.
 *
 * It reads like pollFailureBanner below because the two sit one above the
 * other on the same screen, and the operator should not have to learn that one
 * of them lists everything and the other does not.
 */
export interface ThrottleBanner {
  title: string;
  body: string;
}

export function throttleBanner(views: Array<{ row: SystemRow; live: LivePlaneState | null }>): ThrottleBanner | null {
  const throttled = views
    .filter((v) => v.live?.linked)
    .map((v) => ({
      name: v.row.name,
      total: v.live!.recentCalls.length,
      rate: v.live!.recentCalls.filter((c) => c.code === '429').length,
      note: v.live!.note?.trim(),
    }))
    .filter((t) => t.rate > 0);
  if (throttled.length === 0) return null;
  const body = throttled
    .map((t) => `${t.name} — ${t.rate} of the last ${t.total} calls came back 429.${t.note ? ` Registry note: ${t.note}.` : ''}`)
    .join(' ');
  return {
    title:
      throttled.length === 1
        ? `${throttled[0]!.name} is throttling us`
        : `${throttled.length} systems are throttling us`,
    // The consequence is stated once, after the list, rather than repeated
    // after every plane — it is the same consequence for all of them.
    body: `${body} Inventory from ${throttled.length === 1 ? 'it' : 'them'} falls behind.`,
  };
}

/**
 * Planes whose polls are failing, named on the page instead of left in a
 * drawer.
 *
 * The registry already records why — "auth: neither token endpoint accepted
 * these credentials" and the like — but the only place that reason surfaced
 * was the detail drawer, in the same muted grey as a healthy plane's
 * "34 subscriptions · 14 devices". A plane that could not be polled at all
 * showed as one word on one row, so the first sign of an outage was usually
 * noticing that a number somewhere else had stopped moving.
 *
 * Keyed on consecutiveFailures, not health. 'degraded' also covers a poll that
 * completed and returned less than all of it, which is a different claim with
 * its own signals; this banner only ever means the last poll did not finish.
 *
 * Every failing plane is named rather than just the first, the registry's note
 * is quoted as written, and its absence is said out loud instead of filled in.
 * A plane that has never completed a poll is distinguished from one showing an
 * older read, because that is the difference between stale numbers and none.
 */
export interface PollFailureBanner {
  title: string;
  body: string;
}

export function pollFailureBanner(
  views: Array<{ row: SystemRow; live: LivePlaneState | null }>,
): PollFailureBanner | null {
  const failing = views.filter((v) => v.live?.linked && (v.live.consecutiveFailures ?? 0) > 0);
  if (failing.length === 0) return null;
  const body = failing
    .map((v) => {
      const live = v.live!;
      const n = live.consecutiveFailures!;
      const runs = `${n} consecutive failed poll${n === 1 ? '' : 's'}`;
      const note = live.note?.trim();
      const never = live.lastSync === null ? ' It has never completed one, so nothing here was read from it.' : '';
      return note
        ? `${v.row.name} — ${note} (${runs}).${never}`
        : `${v.row.name} — ${runs}, and the registry recorded no reason.${never}`;
    })
    .join(' ');
  return {
    title:
      failing.length === 1
        ? `${failing[0]!.row.name} is not being polled successfully`
        : `${failing.length} systems are not being polled successfully`,
    body,
  };
}

export interface CallRow {
  time: string;
  path: string;
  ms: string;
  code: string;
  tone: Tone;
}

/** Activity-tab calls: the live registry log when the backend is up, else fixture. */
export function callsFor(s: SystemRow, live: LivePlaneState | null): CallRow[] {
  if (live) {
    return live.recentCalls.map((c) => ({
      time: hhmm(c.time),
      path: c.path,
      ms: msFmt(c.ms),
      code: c.code,
      tone: codeTone(c.code),
    }));
  }
  return s.calls;
}

export interface HistoryRow {
  time: string;
  system: string;
  what: string;
  result: string;
  tone: Tone;
}

/** A drawer section that clears to zero rows says so — README §Interactions:
 *  zero results show an empty state, never a heading over nothing. */
export function NothingReported({ label }: { label: string }) {
  return (
    <div
      style={{
        fontFamily: 'var(--nd-font-mono)',
        fontSize: 10.5,
        color: 'var(--nd-text-muted)',
        padding: '8px 0',
      }}
    >
      {label}
    </div>
  );
}

/** Sync history: the live poller log when present, else the fixture rows. */
export function historyRows(live: LiveSyncEvent[] | null, fixture: SyncHistoryRow[]): HistoryRow[] {
  if (live) {
    return live.slice(0, 10).map((h) => ({
      time: hhmm(h.time),
      system: h.plane,
      what: h.what,
      result: h.result,
      tone: h.result === 'ok' ? 'success' : 'danger',
    }));
  }
  return fixture;
}
