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
 * the alert's device — current state from the poller cache (live mode), the
 * newest brokered writes naming it from the change log, and its recorded
 * shell sessions (data/shell-logs). A snapshot, not a live join: the ticket
 * keeps what was true when it was raised.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { siteIdFor, TICKETS, type AlertRow, type DeviceRow, type SiteId, type TicketEvidence, type TicketNote, type TicketRow, type Tone } from '../../../shared';
import { poller } from './poller';
import { terminalManager, type SessionInfo } from './terminal';
import type { BrokerLogEntry } from './writeBroker';

const SEV_TONE: Record<string, Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

/** Evidence feeds — injectable for tests; defaults are the live singletons. */
export interface EvidenceSources {
  changeLog?: () => BrokerLogEntry[];
  sessions?: () => SessionInfo[];
  devices?: () => DeviceRow[];
}

function hhmmOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
      devices: sources.devices ?? (() => poller.getCache().devices),
    };
  }

  private get file(): string {
    return path.join(this.dataDir, 'tickets.json');
  }

  list(): TicketRow[] {
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
    return this.list();
  }

  /** Highest id so far across stored + fixture-series tickets (NET-4xxx). */
  private nextId(): string {
    const max = this.list().reduce((m, t) => {
      const n = Number(/^NET-(\d+)$/.exec(t.id)?.[1]);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 4200); // fixture series ends at NET-4188; raised tickets start above it
    return `NET-${max + 1}`;
  }

  /** Raise a ticket from an alert row. Idempotent per alert title+device. */
  raiseFromAlert(alert: AlertRow): TicketRow {
    // The device rides on evidence[0] (the alert snapshot written below) — the
    // same title on another device is a different incident, not a duplicate.
    const existing = this.list().find(
      (t) => t.state !== 'resolved' && t.title === alert.title && t.evidence[0]?.device === alert.device,
    );
    if (existing) return existing;

    const id = this.nextId();
    const siteId = siteIdFor(alert.siteName) ?? ('multiple' as SiteId);
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const ticket: TicketRow = {
      id,
      pri: alert.sev,
      tone: SEV_TONE[alert.sev] ?? 'neutral',
      state: 'open',
      title: alert.title,
      siteId,
      siteName: alert.siteName,
      age: 'now',
      reporter: 'portal — raised from the alert queue',
      owner: 'unassigned',
      planes: alert.plane,
      sla: alert.sev === 'P1' ? 'SLA breach in 4h' : alert.sev === 'P2' ? 'SLA breach in 8h' : 'SLA breach in 24h',
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
    this.save([ticket, ...this.list()]);
    return ticket;
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
      const serial = (live as { serial?: string }).serial;
      out.push({
        time: 'now',
        plane: live.plane,
        finding: `current state: ${live.state} · ${live.model} · firmware ${live.firmware}`,
        raw: `source=poller.cache${serial ? ` serial=${serial}` : ''}`,
        device,
      });
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
    const tickets = this.list();
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
    return { ...updated };
  }

  /**
   * Close a ticket: state → 'resolved' with an 'action' note recording the
   * resolve. Fixture tickets are promoted into the store first, same as on
   * their first note. Idempotent — an already-resolved ticket comes back
   * unchanged (no duplicate note). Returns null for an unknown id.
   */
  resolve(id: string): TicketRow | null {
    const tickets = this.list();
    let idx = tickets.findIndex((t) => t.id === id);
    if (idx === -1) {
      const fixture = TICKETS.find((t) => t.id === id);
      if (!fixture) return null;
      tickets.unshift({ ...fixture, notes: [] });
      idx = 0;
    }
    const cur = tickets[idx];
    if (!cur) return null;
    if (cur.state === 'resolved') return { ...cur };
    const note: TicketNote = { ts: new Date().toISOString(), kind: 'action', text: 'Ticket resolved' };
    const updated: TicketRow = { ...cur, state: 'resolved', notes: [...(cur.notes ?? []), note] };
    tickets[idx] = updated;
    this.save(tickets);
    return { ...updated };
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
