import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_NOTES_PER_TICKET, TicketStore, capNotes, type BrokerLogRead } from '../src/services/tickets';
import type { BrokerLogEntry } from '../src/services/writeBroker';
import type { AlertRow, TicketNote } from '@hpe/shared';

const ALERT: AlertRow = {
  sev: 'P1',
  tone: 'danger',
  title: 'Riverside Clinic offline — WAN down',
  detail: 'wan1 down 12m · lte failover did not engage',
  siteId: 'riverside',
  siteName: 'Riverside Clinic',
  plane: 'CLASSIC',
  state: 'open',
  age: '12m',
  device: 'sw-riv-1',
};

/** A change-log read with no known holes: what every fixture here means. */
const logOf = (entries: BrokerLogEntry[] = []): BrokerLogRead => ({
  entries,
  discarded: [],
  unreadable: [],
  truncated: false,
});

describe('TicketStore', () => {
  let dir: string;
  let store: TicketStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpe-tickets-'));
    store = new TicketStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty and persists across instances', () => {
    expect(store.list()).toEqual([]);
    const t = store.raiseFromAlert(ALERT);
    expect(t.id).toMatch(/^NET-\d+$/);
    expect(new TicketStore(dir).list()).toHaveLength(1);
  });

  it('raises above the fixture series and maps alert fields honestly', () => {
    const t = store.raiseFromAlert(ALERT);
    expect(Number(t.id.slice(4))).toBeGreaterThan(4200);
    expect(t.pri).toBe('P1');
    expect(t.tone).toBe('danger');
    expect(t.state).toBe('open');
    expect(t.cause).toBe(ALERT.detail);
    expect(t.evidence).toHaveLength(1);
    expect(t.evidence[0].device).toBe('sw-riv-1');
  });

  it('is idempotent per open alert title+device', () => {
    const a = store.raiseFromAlert(ALERT);
    const b = store.raiseFromAlert(ALERT);
    expect(b.id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
  });

  it('raises one ticket per device when the same alert title fires on two devices', () => {
    const a = store.raiseFromAlert(ALERT);
    const b = store.raiseFromAlert({ ...ALERT, device: 'sw-riv-2' });
    expect(b.id).not.toBe(a.id);
    expect(store.list()).toHaveLength(2);
    expect(b.evidence[0].device).toBe('sw-riv-2');
    // …and the second device's ticket is itself idempotent
    expect(store.raiseFromAlert({ ...ALERT, device: 'sw-riv-2' }).id).toBe(b.id);
  });

  it('falls back to the multiple pseudo-site for unknown site names', () => {
    const t = store.raiseFromAlert({ ...ALERT, title: 'x', siteName: 'Nowhere Known' });
    expect(t.siteId).toBe('multiple');
  });

  it('writes the store file with mode 0600', () => {
    store.raiseFromAlert(ALERT);
    const mode = fs.statSync(path.join(dir, 'tickets.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('appends notes and actions to a raised ticket and persists them', () => {
    const t = store.raiseFromAlert(ALERT);
    const noted = store.addNote(t.id, 'ISP engaged — waiting on the WAN provider');
    const acted = store.addNote(t.id, 'Fail over to LTE manually', 'action');
    expect(noted?.notes).toHaveLength(1);
    expect(acted?.notes).toHaveLength(2);
    expect(acted?.notes?.[0]).toMatchObject({ kind: 'note', text: 'ISP engaged — waiting on the WAN provider' });
    expect(acted?.notes?.[1]).toMatchObject({ kind: 'action', text: 'Fail over to LTE manually' });
    expect(Date.parse(acted?.notes?.[0].ts ?? '')).not.toBeNaN();
    expect(new TicketStore(dir).list()[0].notes).toHaveLength(2);
  });

  it('does not mutate the in-memory ticket when persistence fails', () => {
    const t = store.raiseFromAlert(ALERT);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'blocks directory recreation');

    expect(() => store.addNote(t.id, 'must not stick')).toThrow();
    expect(store.list()[0].notes ?? []).toEqual([]);
  });

  it('promotes a fixture ticket into the store on its first note', () => {
    expect(store.list()).toEqual([]);
    const updated = store.addNote('NET-4188', 'watching this overnight');
    expect(updated).not.toBeNull();
    expect(updated?.id).toBe('NET-4188');
    expect(updated?.title).toContain('Wi-Fi drops');
    expect(updated?.notes).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  it('returns null for a ticket id the merged queue does not know', () => {
    expect(store.addNote('NET-9999', 'nothing to attach this to')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('resolves a raised ticket with an action note, persists, and is idempotent', () => {
    const t = store.raiseFromAlert(ALERT);
    const resolved = store.resolve(t.id);
    expect(resolved?.state).toBe('resolved');
    expect(resolved?.notes).toHaveLength(1);
    expect(resolved?.notes?.[0]).toMatchObject({ kind: 'action', text: 'Ticket resolved' });
    expect(new TicketStore(dir).list()[0].state).toBe('resolved');

    // A second resolve is a harmless no-op — no duplicate note.
    const again = store.resolve(t.id);
    expect(again?.state).toBe('resolved');
    expect(again?.notes).toHaveLength(1);
  });

  it('promotes a fixture ticket into the store to resolve it', () => {
    expect(store.list()).toEqual([]);
    const resolved = store.resolve('NET-4173');
    expect(resolved?.id).toBe('NET-4173');
    expect(resolved?.state).toBe('resolved');
    expect(resolved?.notes).toHaveLength(1);
    expect(store.list().find((t) => t.id === 'NET-4173')?.state).toBe('resolved');
  });

  it('returns null when resolving an unknown ticket id', () => {
    expect(store.resolve('NET-9999')).toBeNull();
    expect(store.list()).toEqual([]);
  });
});

describe('TicketStore evidence collection', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpe-tickets-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const LIVE_DEVICE = {
    name: 'sw-riv-1',
    model: 'Aruba CX 6300M-48G',
    type: 'switch' as const,
    plane: 'CLASSIC' as const,
    state: 'Down',
    firmware: '10.11.1030',
    firmwareApproved: false,
    licence: '—',
    reconciliationIssue: false,
    localShell: true,
    siteId: 'riverside' as const,
    siteName: 'Riverside Clinic',
    planeTone: 'neutral' as const,
    stateTone: 'danger' as const,
  };

  it('gathers cache state, matching change-log writes and shell sessions', () => {
    const store = new TicketStore(dir, {
      devices: () => [LIVE_DEVICE],
      changeLog: () => logOf([
        { ts: '2026-07-26T09:00:00Z', event: 'reboot', changeId: 'reboot-sw-core-a', ticket: 'NET-4100', kind: 'reboot', result: 'applied', httpCode: 202 },
        { ts: '2026-07-26T09:05:00Z', event: 'reboot', changeId: 'reboot-sw-riv-1', ticket: 'NET-4101', kind: 'reboot', result: 'rejected', httpCode: 404 },
        { ts: '2026-07-26T09:10:00Z', event: 'alert-ack', changeId: 'alert-ack-sw-riv-1 wan down', ticket: 'NET-4102', kind: 'alert', result: 'acknowledged', httpCode: 202 },
      ]),
      sessions: () => [
        { file: 'sw-riv-1-2026-07-26T08-00-00.jsonl', device: 'sw-riv-1', user: 'r.okafor', target: '10.42.8.11', openedAt: '2026-07-26T08:00:00Z' },
        { file: 'sw-core-a-2026-07-26T07-00-00.jsonl', device: 'sw-core-a', user: 'r.okafor', target: '10.42.0.14', openedAt: '2026-07-26T07:00:00Z' },
      ],
    });

    const t = store.raiseFromAlert(ALERT);
    // alert row + live state + 2 matching writes (newest first) + 1 session
    expect(t.evidence).toHaveLength(5);
    expect(t.evidence[0].raw).toContain('source=portal.alert');
    expect(t.evidence[1]).toMatchObject({ time: 'now', plane: 'CLASSIC' });
    expect(t.evidence[1].finding).toContain('current state: Down');
    expect(t.evidence[2].finding).toBe('portal write: alert-ack — acknowledged');
    expect(t.evidence[3].finding).toBe('portal write: reboot — rejected');
    expect(t.evidence[4]).toMatchObject({ plane: 'LOCAL SSH' });
    expect(t.evidence[4].raw).toBe('recording=sw-riv-1-2026-07-26T08-00-00.jsonl');
    // nothing from other devices leaked in
    expect(t.evidence.every((e) => e.device === 'sw-riv-1')).toBe(true);
    // A whole log claims no holes. A caveat printed over intact evidence is
    // one an auditor learns to discount everywhere else.
    expect(t.evidence.some((e) => e.finding.includes('incomplete'))).toBe(false);
  });

  /* The writes list is filtered to a single device, which is exactly why a
   * hole in the log has to be stated. A generation retention deleted, or one
   * that will not open, cannot be searched for this serial — so the writes
   * that would contradict "no portal writes for this device" are precisely
   * the ones that are gone. Evidence is snapshotted onto the ticket, so the
   * caveat has to be snapshotted with it: a line in the server console is not
   * attached to what an auditor reads a year later. */
  it('records a discarded stretch of change-log history as evidence in its own right', () => {
    const store = new TicketStore(dir, {
      devices: () => [],
      sessions: () => [],
      changeLog: () => ({
        entries: [],
        discarded: [{ from: '2026-01-05T12:00:00Z', to: '2026-02-11T12:00:00Z' }],
        unreadable: [],
        truncated: false,
      }),
    });

    const t = store.raiseFromAlert(ALERT);
    const gap = t.evidence.find((e) => e.finding.includes('incomplete'));
    expect(gap).toBeTruthy();
    expect(gap?.finding).toContain('may not be listed');
    expect(gap?.raw).toContain('discarded=1');
    expect(gap?.raw).toContain('covering=2026-01-05T12:00:00Z..2026-02-11T12:00:00Z');
    expect(gap?.device).toBe('sw-riv-1');
  });

  it('records a generation that would not open, which is a different failure from a deleted one', () => {
    const store = new TicketStore(dir, {
      devices: () => [],
      sessions: () => [],
      changeLog: () => ({ entries: [], discarded: [], unreadable: ['change-log.2.jsonl'], truncated: false }),
    });

    const t = store.raiseFromAlert(ALERT);
    const gap = t.evidence.find((e) => e.finding.includes('incomplete'));
    expect(gap?.raw).toContain('unreadable=1');
    expect(gap?.raw).toContain('discarded=0');
    // No span to quote, and none must be invented.
    expect(gap?.raw).not.toContain('covering=');
  });

  /* Evidence is snapshotted onto the ticket and read by an auditor a year
   * later. The change log is read newest-first and capped, so what falls off
   * the cap is the OLDEST — the half an audit is usually asking about. A
   * healthy disk is enough to cause it; nothing has to go wrong. */
  it('records a change log longer than it was willing to read as a gap in the evidence', () => {
    const store = new TicketStore(dir, {
      devices: () => [],
      sessions: () => [],
      changeLog: () => ({ entries: [], discarded: [], unreadable: [], truncated: true }),
    });

    const t = store.raiseFromAlert(ALERT);
    const gap = t.evidence.find((e) => e.finding.includes('incomplete'));
    expect(gap).toBeTruthy();
    expect(gap?.raw).toContain('truncated=');
    expect(gap?.raw).toContain('discarded=0');
    expect(gap?.raw).toContain('unreadable=0');
  });

  it('claims no gap at all when the log was read whole', () => {
    // The caveat has to stay rare or it stops being read.
    const store = new TicketStore(dir, {
      devices: () => [],
      sessions: () => [],
      changeLog: () => ({ entries: [], discarded: [], unreadable: [], truncated: false }),
    });

    expect(store.raiseFromAlert(ALERT).evidence.some((e) => e.finding.includes('incomplete'))).toBe(false);
  });

  // timeSpan returns null when the deleted generation's own lines would not
  // parse. The gap is still a fact; only its width is unknown.
  it('states a discarded stretch whose span is unknown without inventing one', () => {
    const store = new TicketStore(dir, {
      devices: () => [],
      sessions: () => [],
      changeLog: () => ({ entries: [], discarded: [{ from: null, to: null }], unreadable: [], truncated: false }),
    });

    const t = store.raiseFromAlert(ALERT);
    const gap = t.evidence.find((e) => e.finding.includes('incomplete'));
    expect(gap?.raw).toContain('discarded=1');
    expect(gap?.raw).not.toContain('covering=');
  });

  // The disclosure must not displace the evidence it qualifies.
  it('keeps the matching writes alongside the gap it discloses', () => {
    const store = new TicketStore(dir, {
      devices: () => [],
      sessions: () => [],
      changeLog: () => ({
        entries: [
          { ts: '2026-07-26T09:05:00Z', event: 'reboot', changeId: 'reboot-sw-riv-1', ticket: 'NET-4101', kind: 'reboot', result: 'rejected', httpCode: 404 },
        ],
        discarded: [{ from: '2026-01-05T12:00:00Z', to: '2026-02-11T12:00:00Z' }],
        unreadable: [],
        truncated: false,
      }),
    });

    const t = store.raiseFromAlert(ALERT);
    expect(t.evidence.some((e) => e.finding === 'portal write: reboot — rejected')).toBe(true);
    expect(t.evidence.some((e) => e.finding.includes('incomplete'))).toBe(true);
  });

  it('quotes a stale plane\'s device as unverified and flags a double claim', () => {
    // What reconcileDevices() hands back for a device two planes claim while
    // its only claimants are stale: state downgraded, claimedBy carried.
    const store = new TicketStore(dir, {
      devices: () => [
        {
          ...LIVE_DEVICE,
          state: 'unverified',
          stateTone: 'neutral' as const,
          reconciliationIssue: true,
          claimedBy: ['CLASSIC' as const, 'CENTRAL' as const],
          serial: 'CN12AB34CD',
        },
      ],
      changeLog: () => logOf(),
      sessions: () => [],
    });

    const t = store.raiseFromAlert(ALERT);
    expect(t.evidence).toHaveLength(3);
    expect(t.evidence[1].finding).toContain('current state: unverified');
    expect(t.evidence[1].finding).not.toContain('current state: Down');
    expect(t.evidence[1].raw).toBe('source=poller.reconciled serial=CN12AB34CD claimed_by=CLASSIC,CENTRAL');
    expect(t.evidence[2].finding).toBe('reconciliation: double-claimed by CLASSIC, CENTRAL');
  });

  it('flags a device no management plane claims', () => {
    const store = new TicketStore(dir, {
      devices: () => [{ ...LIVE_DEVICE, plane: 'LOCAL' as const, reconciliationIssue: true, claimedBy: ['LOCAL' as const] }],
      changeLog: () => logOf(),
      sessions: () => [],
    });
    const t = store.raiseFromAlert(ALERT);
    expect(t.evidence).toHaveLength(3);
    expect(t.evidence[2].finding).toBe('reconciliation: claimed by no management plane (local collector only)');
  });

  it('is just the alert row when the feeds are empty', () => {
    const store = new TicketStore(dir, { devices: () => [], changeLog: () => logOf(), sessions: () => [] });
    const t = store.raiseFromAlert(ALERT);
    expect(t.evidence).toHaveLength(1);
  });

  it('does not re-collect on an idempotent re-raise', () => {
    let writes = 0;
    const store = new TicketStore(dir, {
      devices: () => [],
      changeLog: () => {
        writes += 1;
        return logOf();
      },
      sessions: () => [],
    });
    const a = store.raiseFromAlert(ALERT);
    const b = store.raiseFromAlert(ALERT);
    expect(b.id).toBe(a.id);
    expect(b.evidence).toHaveLength(1);
    expect(writes).toBe(1); // collected once, at the first raise
  });
});

describe('TicketStore age/SLA derivation', () => {
  let dir: string;
  let store: TicketStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpe-tickets-'));
    store = new TicketStore(dir, { devices: () => [], changeLog: () => logOf(), sessions: () => [] });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Rewrite the persisted store as if the ticket had been raised hoursAgo. */
  function backdate(id: string, hoursAgo: number, slaHours: number): TicketStore {
    const file = path.join(dir, 'tickets.json');
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    const raised = Date.now() - hoursAgo * 3_600_000;
    for (const row of rows) {
      if (row.id !== id) continue;
      row.raisedAt = new Date(raised).toISOString();
      row.slaDueAt = new Date(raised + slaHours * 3_600_000).toISOString();
    }
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    return new TicketStore(dir, { devices: () => [], changeLog: () => logOf(), sessions: () => [] });
  }

  it('stamps raisedAt and slaDueAt from the severity table', () => {
    const t = store.raiseFromAlert(ALERT); // P1 → 4h
    expect(Date.parse(t.raisedAt ?? '')).not.toBeNaN();
    expect(Date.parse(t.slaDueAt ?? '') - Date.parse(t.raisedAt ?? '')).toBe(4 * 3_600_000);
    expect(t.age).toBe('now');
    expect(t.sla).toBe('SLA breach in 4h');

    const p3 = store.raiseFromAlert({ ...ALERT, sev: 'P3', title: 'low priority' });
    expect(Date.parse(p3.slaDueAt ?? '') - Date.parse(p3.raisedAt ?? '')).toBe(24 * 3_600_000);
  });

  it('recomputes age and a breached SLA for a ticket raised days ago', () => {
    const t = store.raiseFromAlert(ALERT);
    const reopened = backdate(t.id, 50, 4); // raised 50h ago, SLA was 4h
    const row = reopened.list().find((r) => r.id === t.id);
    expect(row?.age).toBe('2d'); // not 'now'
    expect(row?.sla).toBe('SLA breached 46h ago');
  });

  it('counts an SLA still running down in hours and minutes', () => {
    const t = store.raiseFromAlert(ALERT);
    const reopened = backdate(t.id, 1, 4); // 1h in, 4h SLA → 3h left
    const row = reopened.list().find((r) => r.id === t.id);
    expect(row?.age).toBe('1h');
    expect(row?.sla).toBe('SLA breach in 3h');
  });

  it('closes the SLA countdown once the ticket is resolved', () => {
    const t = store.raiseFromAlert(ALERT);
    const reopened = backdate(t.id, 50, 4);
    const resolved = reopened.resolve(t.id);
    expect(resolved?.sla).toBe('Closed');
    expect(reopened.list().find((r) => r.id === t.id)?.sla).toBe('Closed');
  });

  it('leaves authored fixture strings alone — they carry no timestamps', () => {
    const promoted = store.addNote('NET-4188', 'watching this overnight');
    expect(promoted?.raisedAt).toBeUndefined();
    expect(promoted?.age).toBe('2h');
    expect(promoted?.sla).toBe('SLA breach in 1h 12m');
    expect(store.list()[0].age).toBe('2h');
  });

  // The whole array is re-serialised on every append and this store also
  // gates every write in the portal, so an unbounded log is not a cosmetic
  // problem. What it must not become is a SILENT bound.
  describe('note retention', () => {
    const notesOf = (count: number, kind: 'note' | 'action' = 'note'): TicketNote[] =>
      Array.from({ length: count }, (_, i) => ({
        ts: new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(),
        kind,
        text: `entry ${i}`,
      }));

    it('keeps a short log exactly as written', () => {
      const notes = notesOf(5);
      expect(capNotes(notes)).toEqual(notes);
    });

    it('leaves the log alone at exactly the cap', () => {
      const notes = notesOf(MAX_NOTES_PER_TICKET);
      expect(capNotes(notes)).toEqual(notes);
    });

    it('bounds the log and says so where the dropped entries were', () => {
      const capped = capNotes(notesOf(MAX_NOTES_PER_TICKET + 10));
      expect(capped.length).toBe(MAX_NOTES_PER_TICKET);
      const marker = capped[0];
      expect(marker.kind).toBe('retention');
      expect(marker.discarded).toBe(11);
      expect(marker.text).toContain('11 earlier entries discarded');
      // The newest entry survives; the oldest is the one that went.
      expect(capped[capped.length - 1].text).toBe(`entry ${MAX_NOTES_PER_TICKET + 9}`);
      expect(capped.some((n) => n.text === 'entry 0')).toBe(false);
    });

    it('names the span the marker stands in for', () => {
      const capped = capNotes(notesOf(MAX_NOTES_PER_TICKET + 2));
      expect(capped[0].coveringFrom).toBe('2024-01-01T00:00:00.000Z');
      expect(capped[0].coveringTo).toBe('2024-01-01T00:02:00.000Z');
    });

    it('rolls a previous marker forward instead of restarting the count', () => {
      const once = capNotes(notesOf(MAX_NOTES_PER_TICKET + 10));
      const twice = capNotes([...once, ...notesOf(20)]);
      // 11 from the first rotation plus the 20 entries the second one dropped
      // to make room. A marker that counted only what IT dropped would say 20
      // here, and the log would understate its own gap on every rotation.
      expect(twice[0].kind).toBe('retention');
      expect(twice[0].discarded).toBe(31);
      expect(twice[0].coveringFrom).toBe('2024-01-01T00:00:00.000Z');
    });

    it('bounds a real ticket log through addNote', () => {
      let ticket = store.addNote('NET-4188', 'first');
      for (let i = 0; i < MAX_NOTES_PER_TICKET + 4; i += 1) {
        ticket = store.addNote('NET-4188', `note ${i}`);
      }
      expect(ticket?.notes?.length).toBe(MAX_NOTES_PER_TICKET);
      expect(ticket?.notes?.[0].kind).toBe('retention');
      expect(ticket?.notes?.[0].text).toContain('discarded');
      // And it survives the round trip through disk, not just memory.
      const reread = new TicketStore(dir).list().find((t) => t.id === 'NET-4188');
      expect(reread?.notes?.length).toBe(MAX_NOTES_PER_TICKET);
    });

    it('bounds the resolve note too, so closing a ticket cannot exceed the cap', () => {
      for (let i = 0; i < MAX_NOTES_PER_TICKET; i += 1) store.addNote('NET-4188', `note ${i}`);
      const resolved = store.resolve('NET-4188');
      expect(resolved?.notes?.length).toBe(MAX_NOTES_PER_TICKET);
      expect(resolved?.notes?.[resolved.notes.length - 1].text).toBe('Ticket resolved');
    });
  });
});
