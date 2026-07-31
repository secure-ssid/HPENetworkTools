/**
 * server/src/services/tickets.ts — the portal's own ticket store.
 *
 * Raised tickets (from the Alerts queue) persist to data/tickets.json (0600,
 * atomic write, HPE_DATA_DIR override for tests). They merge with the demo
 * fixtures on /api/tickets — raised tickets are real user data and show in
 * both demo and live mode, ahead of the fixture queue. Operator notes and
 * resolves persist the same way (a fixture ticket is promoted into the store
 * on its first note/resolve, so its log survives).
 *
 * Evidence collection: a raise snapshots what the portal already knows about
 * the alert's device — current state from the RECONCILED poller cache (live
 * mode), the newest brokered writes naming it from the change log, and its
 * recorded shell sessions (data/shell-logs). A snapshot, not a live join: the
 * ticket keeps what was true when it was raised. Reconciled, not raw: a
 * device whose only claiming plane is stale is quoted as 'unverified', and a
 * double-claimed device gets its own evidence row (design rules 1 and 2).
 *
 * Timing: a raised ticket persists `raisedAt`/`slaDueAt` (ISO) and its `age`
 * and `sla` strings are recomputed from those on every read — a ticket raised
 * days ago must not still render "now" with a fresh SLA countdown. The
 * authored fixtures carry no timestamps, so their authored strings stand.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { siteIdFor, TICKETS, type AlertRow, type DeviceRow, type SiteId, type TicketEvidence, type TicketNote, type TicketRow, type Tone } from '@hpe/shared';
import { registry } from '../planes/registry';
import { PLANE_IDS, type PlaneId } from '../planes/types';
import { poller } from './poller';
import { reconcileDevices, type ReconciledDeviceRow } from './reconcile';
import { terminalManager, type SessionInfo } from './terminal';
import type { BrokerLogEntry } from './writeBroker';
import { isRetentionTombstone, readJsonlNewestFirst, type RetentionTombstone } from './logRotation';

/**
 * How far back ticket evidence looks. Bounded because the log now spans
 * rotated generations and could otherwise be tens of megabytes of JSON parsed
 * on every ticket read.
 */
const CHANGE_LOG_READ_LIMIT = 20_000;

/**
 * `MAX_NOTE_CHARS` (in @hpe/shared, so the browser warns against the same
 * number) is why the whole ticket array is not at the mercy of one paste: it
 * is re-serialised and rewritten on every append, and this same store is the
 * write-authorisation gate (`knownTicketId`) — so a ticket file that grows
 * without limit does not merely slow the queue down, it takes every gated
 * write in the portal with it when the write finally fails. Express caps a
 * request body at 1mb, which bounds one note but not a hundred of them.
 *
 * Over-length text is REFUSED, never truncated. Half an incident note filed
 * as though it were whole is the same failure as a green badge over an unread
 * section: the record looks complete and is not.
 *
 * This cap bounds the other axis: the most entries one ticket may hold. Older
 * ones are dropped, but a marker takes their place — the rule the rotating
 * logs already follow: a deletion must not read as an absence of events.
 */
export const MAX_NOTES_PER_TICKET = 200;

/**
 * Trim a ticket's log to `MAX_NOTES_PER_TICKET`, leaving a retention marker
 * where the dropped entries were.
 *
 * The marker occupies one of the kept slots rather than sitting outside the
 * cap, so the bound is a real bound. Its count rolls a previously dropped
 * marker's own total forward: on the second rotation the answer must be
 * "412 entries discarded", not "199", or the log understates its own gap a
 * little more every time it rotates.
 */
export function capNotes(notes: TicketNote[]): TicketNote[] {
  if (notes.length <= MAX_NOTES_PER_TICKET) return notes;
  const kept = notes.slice(notes.length - (MAX_NOTES_PER_TICKET - 1));
  const dropped = notes.slice(0, notes.length - kept.length);
  const discarded = dropped.reduce(
    (sum, n) => sum + (n.kind === 'retention' ? (n.discarded ?? 0) : 1),
    0,
  );
  const from = dropped.find((n) => n.kind === 'retention' && n.coveringFrom)?.coveringFrom ?? dropped[0]?.ts;
  const to = dropped[dropped.length - 1]?.ts;
  const span = from && to ? ` covering ${from} to ${to}` : '';
  const marker: TicketNote = {
    ts: new Date().toISOString(),
    kind: 'retention',
    text:
      `${discarded} earlier ${discarded === 1 ? 'entry' : 'entries'} discarded${span} — this ticket keeps ` +
      `the most recent ${MAX_NOTES_PER_TICKET - 1}. Those entries are no longer available here.`,
    discarded,
    ...(from ? { coveringFrom: from } : {}),
    ...(to ? { coveringTo: to } : {}),
  };
  return [marker, ...kept];
}

const SEV_TONE: Record<string, Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

/** Hours until SLA breach per severity — the deadline stamped at raise time. */
const SLA_HOURS: Record<string, number> = { P1: 4, P2: 8, P3: 24 };

/** Evidence feeds — injectable for tests; defaults are the live singletons. */
/**
 * A read of the brokered-write log for evidence purposes, with the holes it
 * knows about. The entries alone cannot say why they are few: a generation
 * the retention policy deleted and one that will not open both leave the
 * trail short, and a short trail is indistinguishable from a device nobody
 * ever pushed a change to. For evidence attached to a ticket that distinction
 * is the whole point, so both travel with the rows.
 */
export interface BrokerLogRead {
  entries: BrokerLogEntry[];
  /** Spans deleted by retention; bounds are null when they could not be read. */
  discarded: { from: string | null; to: string | null }[];
  unreadable: string[];
  /** True when the read hit its cap and older entries exist behind it. */
  truncated: boolean;
}

export interface EvidenceSources {
  changeLog?: () => BrokerLogRead;
  sessions?: () => SessionInfo[];
  devices?: () => ReconciledDeviceRow[];
}

/**
 * The instant an evidence row happened, left for the browser to render in the
 * reader's own clock (shared/logic.ts hhmmLocal).
 *
 * Formatting it here produced hh:mm in the SERVER's timezone, which the
 * ticket drawer then showed alongside note timestamps the browser formats
 * itself — two clocks, one column, identical shape. Evidence is snapshotted
 * onto the ticket and read later by someone who was not there; a time in an
 * unstated zone is a worse fact than an instant.
 *
 * Unparseable still resolves to '—' rather than being passed through: it is
 * not an instant, and a time column is not the place to print whatever it
 * was instead.
 */
function timeOf(iso: string): string {
  return Number.isNaN(new Date(iso).getTime()) ? '—' : iso;
}

/** Planes currently failing and serving last-good data — "stale" for reconcile. */
function stalePlanes(): Set<PlaneId> {
  const out = new Set<PlaneId>();
  for (const id of PLANE_IDS) {
    if (registry.state(id).health === 'degraded') out.add(id);
  }
  return out;
}

/** The poller cache read the way every screen reads it: one row per physical
 *  device, stale-only claims downgraded to 'unverified', double claims flagged. */
function reconciledDevices(): ReconciledDeviceRow[] {
  const byPlane: Partial<Record<PlaneId, readonly DeviceRow[]>> = {};
  for (const [id, pull] of poller.contributionsByPlane()) {
    if (pull.devices) byPlane[id] = pull.devices;
  }
  return reconcileDevices(byPlane, stalePlanes()).devices;
}

/** Elapsed time in the fixtures' age vocabulary ('now', '12m', '6h', '2d'). */
function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** SLA line in the fixtures' vocabulary: 'SLA breach in 1h 12m' / breached. */
function formatSla(msLeft: number): string {
  const mins = Math.round(Math.abs(msLeft) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const span = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  return msLeft >= 0 ? `SLA breach in ${span}` : `SLA breached ${span} ago`;
}

/**
 * Recompute `age`/`sla` for an operator-raised ticket from its stored
 * timestamps. A ticket without `raisedAt` is an authored fixture (or a row
 * written before timestamps existed) — its authored strings are authoritative
 * and pass through untouched.
 */
export function withDerivedTiming(ticket: TicketRow, now: number = Date.now()): TicketRow {
  const raisedAt = ticket.raisedAt ? Date.parse(ticket.raisedAt) : NaN;
  if (Number.isNaN(raisedAt)) return { ...ticket };
  const dueAt = ticket.slaDueAt ? Date.parse(ticket.slaDueAt) : NaN;
  const sla = ticket.state === 'resolved' ? 'Closed' : Number.isNaN(dueAt) ? ticket.sla : formatSla(dueAt - now);
  return { ...ticket, age: formatAge(now - raisedAt), sla };
}

export class TicketStore {
  private tickets: TicketRow[] | null = null;
  private readonly sources: Required<EvidenceSources>;

  constructor(
    private readonly dataDir: string = process.env.HPE_DATA_DIR ?? path.resolve(__dirname, '..', '..', '..', 'data'),
    sources: EvidenceSources = {},
  ) {
    this.sources = {
      changeLog: sources.changeLog ?? (() => this.readChangeLog()),
      sessions: sources.sessions ?? (() => terminalManager.listSessions()),
      devices: sources.devices ?? (() => reconciledDevices()),
    };
  }

  private get file(): string {
    return path.join(this.dataDir, 'tickets.json');
  }

  /** Rows exactly as persisted — the basis for every mutation and write. */
  private stored(): TicketRow[] {
    if (this.tickets !== null) return this.tickets.map((t) => ({ ...t }));
    this.tickets = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.tickets = parsed as TicketRow[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`tickets: unreadable store, starting empty: ${(err as Error).message}`);
      }
    }
    return this.stored();
  }

  /** The queue as it should read right now: `age`/`sla` on raised tickets are
   *  derived from their timestamps, never served frozen at the raise moment. */
  list(): TicketRow[] {
    return this.stored().map((t) => withDerivedTiming(t));
  }

  /** Highest id so far across stored + fixture-series tickets (NET-4xxx). */
  private nextId(): string {
    const max = this.stored().reduce((m, t) => {
      const n = Number(/^NET-(\d+)$/.exec(t.id)?.[1]);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 4200); // fixture series ends at NET-4188; raised tickets start above it
    return `NET-${max + 1}`;
  }

  /** Raise a ticket from an alert row. Idempotent per alert title+device. */
  raiseFromAlert(alert: AlertRow): TicketRow {
    // The device rides on evidence[0] (the alert snapshot written below) — the
    // same title on another device is a different incident, not a duplicate.
    const existing = this.stored().find(
      (t) => t.state !== 'resolved' && t.title === alert.title && t.evidence[0]?.device === alert.device,
    );
    if (existing) return withDerivedTiming(existing);

    const id = this.nextId();
    const siteId = siteIdFor(alert.siteName) ?? ('multiple' as SiteId);
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const slaDueAt = new Date(now.getTime() + (SLA_HOURS[alert.sev] ?? 24) * 3_600_000);
    const ticket: TicketRow = {
      id,
      pri: alert.sev,
      tone: SEV_TONE[alert.sev] ?? 'neutral',
      state: 'open',
      title: alert.title,
      siteId,
      siteName: alert.siteName,
      // age/sla are derived from the timestamps below on every read — these are
      // the raise-moment values, not a frozen claim about the present.
      age: 'now',
      reporter: 'portal — raised from the alert queue',
      owner: 'unassigned',
      planes: alert.plane,
      sla: formatSla(slaDueAt.getTime() - now.getTime()),
      raisedAt: now.toISOString(),
      slaDueAt: slaDueAt.toISOString(),
      inc: id.slice(4),
      causeTitle: 'Likely cause: see the alert detail below',
      cause: alert.detail,
      action1: `Inspect ${alert.device}`,
      action2: `Open in ${alert.plane}`,
      action3: 'Acknowledge the alert',
      evidence: [
        {
          time: hhmm,
          plane: alert.plane,
          finding: `${alert.title} — ${alert.detail}`,
          raw: `source=portal.alert age=${alert.age} state=${alert.state}`,
          device: alert.device,
        },
        ...this.collectEvidence(alert),
      ],
    };
    this.save([ticket, ...this.stored()]);
    return withDerivedTiming(ticket);
  }

  /**
   * Snapshot what the portal already knows about the alert's device: live
   * state from the poller cache, the newest brokered writes naming it, and
   * its recorded shell sessions. Caps keep the evidence list a digest, not a
   * dump; absence of a feed is simply absence (never fabricated rows).
   */
  private collectEvidence(alert: AlertRow): TicketEvidence[] {
    const out: TicketEvidence[] = [];
    const device = alert.device;

    const live = this.sources.devices().find((d) => d.name === device);
    if (live) {
      const claimedBy = live.claimedBy ?? [];
      out.push({
        time: 'now',
        plane: live.plane,
        finding: `current state: ${live.state} · ${live.model} · firmware ${live.firmware}`,
        raw: `source=poller.reconciled${live.serial ? ` serial=${live.serial}` : ''}${claimedBy.length ? ` claimed_by=${claimedBy.join(',')}` : ''}`,
        device,
      });
      // Rule 2: a device two planes both claim (or one no management plane
      // claims) is evidence in its own right, not something to quietly drop.
      if (live.reconciliationIssue) {
        out.push({
          time: 'now',
          plane: live.plane,
          finding:
            claimedBy.length > 1
              ? `reconciliation: double-claimed by ${claimedBy.join(', ')}`
              : 'reconciliation: claimed by no management plane (local collector only)',
          raw: `source=poller.reconciled claimed_by=${claimedBy.join(',') || 'none'}`,
          device,
        });
      }
    }

    const want = device.toLowerCase();
    const log = this.sources.changeLog();
    const writes = log.entries
      .filter((e) => e.changeId.toLowerCase().includes(want))
      .slice(-3)
      .reverse(); // log is append-only (oldest first) — newest 3
    // A hole in the log is not the same fact as a device nobody ever pushed
    // to, and the difference matters most here: this list is filtered to one
    // device, and a generation that was deleted or would not open cannot be
    // searched for it. So the writes that would contradict "no portal writes
    // for this device" are exactly the ones that are gone. Recorded as a row
    // of its own, because evidence is snapshotted onto the ticket and the
    // gap has to travel with it — a caveat left in the server log is not
    // attached to the thing an auditor reads a year from now.
    if (log.discarded.length > 0 || log.unreadable.length > 0 || log.truncated) {
      const spans = log.discarded
        .filter((g) => g.from !== null && g.to !== null)
        .map((g) => `${g.from}..${g.to}`);
      out.push({
        time: 'now',
        plane: 'PORTAL',
        finding:
          `change-log history is incomplete — portal writes for this device before this point may not be listed`,
        raw:
          `source=change-log discarded=${log.discarded.length}` +
          ` unreadable=${log.unreadable.length}` +
          (log.truncated ? ` truncated=${CHANGE_LOG_READ_LIMIT}` : '') +
          (spans.length > 0 ? ` covering=${spans.join(',')}` : ''),
        device,
      });
    }
    for (const e of writes) {
      out.push({
        time: timeOf(e.ts),
        plane: 'PORTAL',
        finding: `portal write: ${e.event} — ${e.result}`,
        raw: `ticket=${e.ticket}${e.httpCode !== undefined ? ` http=${e.httpCode}` : ''}`,
        device,
      });
    }

    for (const s of this.sources.sessions().filter((s) => s.device === device).slice(0, 2)) {
      out.push({
        time: timeOf(s.openedAt),
        plane: 'LOCAL SSH',
        finding: `recorded shell session by ${s.user} (${s.target})`,
        raw: `recording=${s.file}`,
        device,
      });
    }
    return out;
  }

  /** The append-only broker log, parsed defensively; missing file = no writes. */
  private readChangeLog(): BrokerLogRead {
    // Across rotated generations, and back in chronological order: a ticket's
    // evidence must not lose the earlier half of its own history the first
    // time the log rotates.
    const isEntry = (v: unknown): v is BrokerLogEntry =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as BrokerLogEntry).ts === 'string' &&
      typeof (v as BrokerLogEntry).changeId === 'string';
    // The tombstone rotation leaves behind fails isEntry — it has no changeId,
    // because no change happened — and dropping it would send the deleted
    // generation back to looking like a stretch in which nothing was pushed.
    // Widen the guard, then separate the two afterwards.
    const read = readJsonlNewestFirst<BrokerLogEntry | RetentionTombstone>(
      path.join(this.dataDir, 'change-log.jsonl'),
      CHANGE_LOG_READ_LIMIT,
      (v): v is BrokerLogEntry | RetentionTombstone => isEntry(v) || isRetentionTombstone(v),
    );
    // This feeds a ticket's evidence trail. Evidence that is quietly missing a
    // stretch is worse than evidence known to be partial, so say so loudly —
    // to the console for the operator of the host, and, now that the shape has
    // somewhere to put it, in the evidence itself for whoever reads the
    // ticket. They are not the same person and only one of them is looking.
    if (read.unreadable.length > 0) {
      console.error(
        `ticket evidence is incomplete — unreadable change-log generations: ${read.unreadable.join(', ')}`,
      );
    }
    // The cap is the other way this comes back short, and unlike an
    // unreadable generation it needs nothing to go wrong: a long enough
    // history reaches it on a working disk. Newest-first means what falls off
    // is the OLDEST, which is the half of a change log an audit is usually
    // asking about.
    if (read.truncated) {
      console.error(
        `ticket evidence is incomplete — change log longer than the ${CHANGE_LOG_READ_LIMIT}-entry read limit; older entries not searched`,
      );
    }
    const entries: BrokerLogEntry[] = [];
    const discarded: BrokerLogRead['discarded'] = [];
    for (const row of read.entries) {
      if (isRetentionTombstone(row)) discarded.push({ from: row.coveringFrom ?? null, to: row.coveringTo ?? null });
      else entries.push(row);
    }
    return { entries: entries.reverse(), discarded, unreadable: read.unreadable, truncated: read.truncated };
  }

  /**
   * Append a note (or a requested next action) to a ticket's operator log.
   * Fixture tickets are promoted into the store on their first note so the
   * log persists — the route layer dedupes the promoted id out of the
   * fixture queue. Returns the updated ticket, or null for an unknown id.
   *
   * `text` is NOT length-checked here. null already means "no such ticket",
   * and a second meaning on the same value would leave the route guessing
   * which one it got — so the route refuses over-length text against
   * `MAX_NOTE_CHARS` and answers 400, before this is reached. The count cap
   * is a store invariant and is applied here, where every caller gets it.
   */
  addNote(id: string, text: string, kind: TicketNote['kind'] = 'note'): TicketRow | null {
    const tickets = this.stored();
    let idx = tickets.findIndex((t) => t.id === id);
    if (idx === -1) {
      const fixture = TICKETS.find((t) => t.id === id);
      if (!fixture) return null;
      tickets.unshift({ ...fixture, notes: [] });
      idx = 0;
    }
    const cur = tickets[idx];
    if (!cur) return null;
    const note: TicketNote = { ts: new Date().toISOString(), kind, text };
    const updated: TicketRow = { ...cur, notes: capNotes([...(cur.notes ?? []), note]) };
    tickets[idx] = updated;
    this.save(tickets);
    return withDerivedTiming(updated);
  }

  /**
   * Close a ticket: state → 'resolved' with an 'action' note recording the
   * resolve. Fixture tickets are promoted into the store first, same as on
   * their first note. Idempotent — an already-resolved ticket comes back
   * unchanged (no duplicate note). Returns null for an unknown id.
   */
  resolve(id: string): TicketRow | null {
    const tickets = this.stored();
    let idx = tickets.findIndex((t) => t.id === id);
    if (idx === -1) {
      const fixture = TICKETS.find((t) => t.id === id);
      if (!fixture) return null;
      tickets.unshift({ ...fixture, notes: [] });
      idx = 0;
    }
    const cur = tickets[idx];
    if (!cur) return null;
    if (cur.state === 'resolved') return withDerivedTiming(cur);
    const note: TicketNote = { ts: new Date().toISOString(), kind: 'action', text: 'Ticket resolved' };
    const updated: TicketRow = { ...cur, state: 'resolved', notes: capNotes([...(cur.notes ?? []), note]) };
    tickets[idx] = updated;
    this.save(tickets);
    return withDerivedTiming(updated);
  }

  private save(tickets: TicketRow[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tickets, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.tickets = tickets;
  }
}

export const ticketStore = new TicketStore();

/**
 * The ids a write gate may accept as a ticket reference: every raised ticket
 * in the store, plus the fixture queue while demo mode is on (the Clients
 * drawer offers fixture ids as references there). Anything else is a typo,
 * not a ticket — the gates reject it instead of audit-logging it as real.
 */
export function knownTicketId(id: string, demoMode: boolean): boolean {
  if (ticketStore.list().some((t) => t.id === id)) return true;
  return demoMode && TICKETS.some((t) => t.id === id);
}
