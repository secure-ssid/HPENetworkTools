import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TicketStore } from '../src/services/tickets';
import type { AlertRow } from '../../shared';

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
      changeLog: () => [
        { ts: '2026-07-26T09:00:00Z', event: 'reboot', changeId: 'reboot-sw-core-a', ticket: 'NET-4100', kind: 'reboot', result: 'applied', httpCode: 202 },
        { ts: '2026-07-26T09:05:00Z', event: 'reboot', changeId: 'reboot-sw-riv-1', ticket: 'NET-4101', kind: 'reboot', result: 'rejected', httpCode: 404 },
        { ts: '2026-07-26T09:10:00Z', event: 'alert-ack', changeId: 'alert-ack-sw-riv-1 wan down', ticket: 'NET-4102', kind: 'alert', result: 'acknowledged', httpCode: 202 },
      ],
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
      changeLog: () => [],
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
      changeLog: () => [],
      sessions: () => [],
    });
    const t = store.raiseFromAlert(ALERT);
    expect(t.evidence).toHaveLength(3);
    expect(t.evidence[2].finding).toBe('reconciliation: claimed by no management plane (local collector only)');
  });

  it('is just the alert row when the feeds are empty', () => {
    const store = new TicketStore(dir, { devices: () => [], changeLog: () => [], sessions: () => [] });
    const t = store.raiseFromAlert(ALERT);
    expect(t.evidence).toHaveLength(1);
  });

  it('does not re-collect on an idempotent re-raise', () => {
    let writes = 0;
    const store = new TicketStore(dir, {
      devices: () => [],
      changeLog: () => {
        writes += 1;
        return [];
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
    store = new TicketStore(dir, { devices: () => [], changeLog: () => [], sessions: () => [] });
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
    return new TicketStore(dir, { devices: () => [], changeLog: () => [], sessions: () => [] });
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
});
