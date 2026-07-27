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
import { siteIdFor, TICKETS, type AlertRow, type DeviceRow, type SiteId, type TicketEvidence, type TicketNote, type TicketRow, type Tone } from '../../../shared';
import { registry } from '../planes/registry';
import { PLANE_IDS, type PlaneId } from '../planes/types';
import { poller } from './poller';
import { reconcileDevices, type ReconciledDeviceRow } from './reconcile';
import { terminalManager, type SessionInfo } from './terminal';
import type { BrokerLogEntry } from './writeBroker';

const SEV_TONE: Record<string, Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

/** Hours until SLA breach per severity — the deadline stamped at raise time. */
const SLA_HOURS: Record<string, number> = { P1: 4, P2: 8, P3: 24 };

/** Evidence feeds — injectable for tests; defaults are the live singletons. */
export interface EvidenceSources {
  changeLog?: () => BrokerLogEntry[];
  sessions?: () => SessionInfo[];
  devices?: () => ReconciledDeviceRow[];
}

function hhmmOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
    const writes = this.sources
      .changeLog()
      .filter((e) => e.changeId.toLowerCase().includes(want))
      .slice(-3)
      .reverse(); // log is append-only (oldest first) — newest 3
    for (const e of writes) {
      out.push({
        time: hhmmOf(e.ts),
        plane: 'PORTAL',
        finding: `portal write: ${e.event} — ${e.result}`,
        raw: `ticket=${e.ticket}${e.httpCode !== undefined ? ` http=${e.httpCode}` : ''}`,
        device,
      });
    }

    for (const s of this.sources.sessions().filter((s) => s.device === device).slice(0, 2)) {
      out.push({
        time: hhmmOf(s.openedAt),
        plane: 'LOCAL SSH',
        finding: `recorded shell session by ${s.user} (${s.target})`,
        raw: `recording=${s.file}`,
        device,
      });
    }
    return out;
  }

  /** The append-only broker log, parsed defensively; missing file = no writes. */
  private readChangeLog(): BrokerLogEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.dataDir, 'change-log.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const out: BrokerLogEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as BrokerLogEntry;
        if (typeof e.ts === 'string' && typeof e.changeId === 'string') out.push(e);
      } catch {
        // corrupt line — skip it
      }
    }
    return out;
  }

  /**
   * Append a note (or a requested next action) to a ticket's operator log.
   * Fixture tickets are promoted into the store on their first note so the
   * log persists — the route layer dedupes the promoted id out of the
   * fixture queue. Returns the updated ticket, or null for an unknown id.
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
    const updated: TicketRow = { ...cur, notes: [...(cur.notes ?? []), note] };
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
    const updated: TicketRow = { ...cur, state: 'resolved', notes: [...(cur.notes ?? []), note] };
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
