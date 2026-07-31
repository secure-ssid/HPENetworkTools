/**
 * server/tests/configureStats.test.ts — the Configure screen's "Pushed today"
 * tile, which is a rendering of the brokered-write audit log.
 *
 * The broker is stubbed at readRecentEvents so no log file, rotation or clock
 * is involved: these assertions are about how a set of push outcomes is
 * reported, not about how they got onto disk.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Must be set before the settings singleton is constructed at import time —
// the real data/settings.json is never touched by the suite.
const tmp = mkdtempSync(join(tmpdir(), 'hpe-configure-stats-'));
process.env.HPE_SETTINGS_PATH = join(tmp, 'settings.json');
process.env.HPE_DATA_DIR = join(tmp, 'data');

let liveConfigureStats: typeof import('../src/routes/screens/configureModel').liveConfigureStats;
let pushOutcomesToday: typeof import('../src/routes/screens/configureModel').pushOutcomesToday;
let liveOverviewChanges: typeof import('../src/routes/screens/overviewModel').liveOverviewChanges;
let writeBroker: typeof import('../src/services/writeBroker').writeBroker;

beforeAll(async () => {
  ({ liveConfigureStats, pushOutcomesToday } = await import('../src/routes/screens/configureModel'));
  ({ liveOverviewChanges } = await import('../src/routes/screens/overviewModel'));
  ({ writeBroker } = await import('../src/services/writeBroker'));
});

const today = (): string => new Date().toISOString().slice(0, 10);

/** A broker push event stamped today, with the given result string. */
function push(result: string, id = 'c1'): Record<string, unknown> {
  return {
    ts: `${today()}T09:00:00.000Z`,
    event: 'push',
    changeId: id,
    ticket: 'NET-1',
    kind: 'vlan',
    result,
  };
}

function stubLog(
  events: Record<string, unknown>[],
  unreadable: string[] = [],
  truncated = false,
): void {
  vi.spyOn(writeBroker, 'readRecentEvents').mockReturnValue({
    events: events as never,
    unreadable,
    truncated,
  });
}

/** The tile under test is the second in the strip. */
function pushedTile(): { value: string; delta: string; tone: string } {
  return liveConfigureStats([], null, '', null)[1] as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Configure "Pushed today" tile', () => {
  /* The tile counted only `applied` and printed a fixed caption, so a day on
   * which every push was rejected rendered "0 · from the broker audit log" —
   * character for character the same screen as a day on which nobody pushed
   * anything at all. The one case an operator most needs to notice was the
   * one made invisible. */
  it('does not render a day of failed pushes as a day with no pushes', () => {
    stubLog([push('rejected', 'c1'), push('network-error', 'c2'), push('lease-expired', 'c3')]);

    const tile = pushedTile();
    // Nothing landed, so the headline is still zero — failures must not be
    // laundered into the applied count to make the tile look busy.
    expect(tile.value).toBe('0');
    expect(tile.delta).toContain('3 failed');
    expect(tile.delta).not.toBe('from the broker audit log');
    expect(tile.tone).toBe('negative');
  });

  it('withholds green when a push failed alongside one that landed', () => {
    stubLog([push('applied', 'c1'), push('rejected', 'c2')]);

    const tile = pushedTile();
    expect(tile.value).toBe('1');
    expect(tile.delta).toContain('1 failed');
    // A push that worked does not cancel out one that didn't.
    expect(tile.tone).toBe('negative');
    expect(tile.tone).not.toBe('positive');
  });

  /* A 202 is the plane accepting the change, not confirming it. The broker
   * records that distinction deliberately; the tile must not spend it by
   * rounding these into either column. */
  it('counts an accepted-but-unconfirmed push as neither applied nor failed', () => {
    stubLog([push('accepted (unconfirmed)', 'c1'), push('applied', 'c2')]);

    const tile = pushedTile();
    expect(tile.value).toBe('1');
    expect(tile.delta).toContain('1 accepted, unconfirmed');
    expect(tile.delta).not.toContain('failed');
    // Nothing failed, so this is not negative — but one change is unconfirmed,
    // so it is not a clean day either.
    expect(tile.tone).toBe('neutral');
    expect(pushOutcomesToday()).toMatchObject({ applied: 1, accepted: 1, failed: 0 });
  });

  /* readRecentEvents' own doc: a rotated generation that cannot be opened
   * makes the log come back short, and "nothing was brokered here" and "part
   * of the record is unreachable" are opposite claims. A count taken over a
   * short log is a smaller number stated with full confidence. */
  it('declines to be certain when part of the audit log could not be read', () => {
    stubLog([push('applied', 'c1')], ['change-log.1.jsonl']);

    const tile = pushedTile();
    expect(tile.value).toBe('1');
    expect(tile.delta).toContain('1 log generation unreadable');
    expect(tile.delta).toContain('count may be short');
    expect(tile.tone).toBe('neutral');
    expect(tile.tone).not.toBe('positive');
  });

  /* The other way the count goes short, and the one that needs nothing to go
   * wrong. The read takes the newest 1000 broker events of every kind and
   * only then keeps today's pushes, so a busy enough day loses its earliest
   * pushes off the back of the window — with the log perfectly healthy. */
  it('declines to be certain when the read stopped at its own limit', () => {
    stubLog([push('applied', 'c1')], [], true);

    const tile = pushedTile();
    expect(tile.value).toBe('1');
    expect(tile.delta).toContain('count may be short');
    expect(tile.delta).toContain('1000 broker events');
    expect(tile.tone).toBe('neutral');
    expect(tile.tone).not.toBe('positive');
    expect(pushOutcomesToday().truncated).toBe(true);
  });

  /* Both caveats mean the same thing — "at least this many" — and the tile
   * gets one sentence for it, not two arguing over which shortfall to blame. */
  it('says the count may be short once, however many reasons there are', () => {
    stubLog([push('applied', 'c1')], ['change-log.1.jsonl'], true);

    const tile = pushedTile();
    expect(tile.delta.match(/count may be short/g)).toHaveLength(1);
    expect(tile.delta).toContain('unreadable');
  });

  // The fix fails by painting every day amber, so the clean day is pinned.
  it('still reports a clean day of applied pushes as positive', () => {
    stubLog([push('applied', 'c1'), push('applied (discarded mid-push)', 'c2')]);

    const tile = pushedTile();
    expect(tile).toMatchObject({ value: '2', delta: 'from the broker audit log', tone: 'positive' });
  });

  // ...and a genuinely quiet day is still quiet, not a failure.
  it('reports a day with no pushes at all as neutral', () => {
    stubLog([]);

    expect(pushedTile()).toMatchObject({ value: '0', delta: 'from the broker audit log', tone: 'neutral' });
  });

  // Yesterday's failures are not today's problem — the date filter must not
  // be widened by the outcome split.
  it('ignores pushes logged on another day', () => {
    stubLog([{ ...push('rejected'), ts: '2020-01-01T09:00:00.000Z' }, push('applied', 'c2')]);

    const tile = pushedTile();
    expect(tile).toMatchObject({ value: '1', tone: 'positive' });
    expect(tile.delta).not.toContain('failed');
  });

  // Only pushes count. A dry-run that came back empty is not a failed push.
  it('counts only push events, not dry-runs or queue entries', () => {
    stubLog([
      { ...push('applied'), event: 'dry-run', result: 'read-back failed' },
      { ...push('applied'), event: 'queue', result: 'needs window' },
      push('applied', 'c3'),
    ]);

    expect(pushOutcomesToday()).toMatchObject({ applied: 1, accepted: 0, failed: 0, total: 1 });
  });
});

/* The same audit log, rendered as the Overview's Change log panel. Its empty
 * state calls a blank log "a fact, not a failure" — true until a rotated
 * generation cannot be opened, at which point the identical blank panel
 * asserts nothing was ever brokered here over a history that exists and is
 * unreachable. readRecentEvents exists precisely to tell those apart. */
describe('Overview change log completeness', () => {
  it('reports the generations it could not read', () => {
    stubLog([push('applied', 'c1')], ['change-log.1.jsonl', 'change-log.2.jsonl']);

    const result = liveOverviewChanges();
    expect(result.changes.length).toBe(1);
    expect(result.unreadable).toBe(2);
  });

  // The dangerous shape: nothing readable AND part of the record missing.
  it('does not present an unreadable record as an empty one', () => {
    stubLog([], ['change-log.1.jsonl']);

    const result = liveOverviewChanges();
    expect(result.changes).toEqual([]);
    // Same empty list as a quiet portal — the count is the only thing that
    // distinguishes them, so it must not be dropped.
    expect(result.unreadable).toBe(1);
  });

  it('reports a genuinely quiet log as readable and empty', () => {
    stubLog([]);

    expect(liveOverviewChanges()).toMatchObject({ changes: [], unreadable: 0 });
  });
});

/* The rotation tombstone is written into the same JSONL file as the brokered
 * writes, and exists for one reason: a generation deleted by the retention
 * policy must not make "no record of that change" look like "that change
 * never happened". It is not a BrokerEventRow, though — no changeId, no
 * ticket, no kind, because no change happened. The generic row builder
 * interpolated all three regardless, so the single most important line in the
 * log arrived reading "log-retention undefined — discarded" by "undefined ·
 * write broker": the disclosure was there and was the one row an operator
 * would dismiss as a bug. */
describe('Overview change log — retention tombstone', () => {
  function tombstone(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ts: `${today()}T04:00:00.000Z`,
      event: 'log-retention',
      result: 'discarded',
      file: 'change-log.5.jsonl',
      bytes: 16_777_216,
      note: 'oldest retained generation deleted by retention policy',
      ...extra,
    };
  }

  it('never prints "undefined" at the three fields a tombstone does not carry', () => {
    stubLog([tombstone()]);

    const [row] = liveOverviewChanges().changes;
    expect(row.text.includes('undefined')).toBe(false);
    expect(row.who.includes('undefined')).toBe(false);
  });

  it('says the history was discarded rather than naming a raw event', () => {
    stubLog([tombstone()]);

    const [row] = liveOverviewChanges().changes;
    expect(row.text.toLowerCase().includes('discarded by retention policy')).toBe(true);
    expect(row.text.toLowerCase().includes('no longer available')).toBe(true);
    expect(row.who).toBe('retention · write broker');
  });

  // Width is the whole point: a month of missing audit is a different fact
  // from an hour of it, and hh:mm alone would report neither.
  it('reports the span the discarded generation covered', () => {
    stubLog([
      // Midday UTC: the row renders on the operator's local clock like every
      // other line in this log, so a midnight instant would land on the
      // previous day in any western timezone and make this assertion about
      // the test runner's location rather than about the code.
      tombstone({ coveringFrom: '2026-01-05T12:00:00.000Z', coveringTo: '2026-02-11T12:00:00.000Z' }),
    ]);

    const [row] = liveOverviewChanges().changes;
    expect(row.text.includes('2026-01-05')).toBe(true);
    expect(row.text.includes('2026-02-11')).toBe(true);
  });

  // timeSpan returns null when the generation's own lines could not be parsed.
  // A tombstone with no bounds still has to read as a sentence.
  it('stays legible when the discarded generation had no readable bounds', () => {
    stubLog([tombstone()]);

    const [row] = liveOverviewChanges().changes;
    expect(row.text.includes('covering')).toBe(false);
    expect(row.text.includes('undefined')).toBe(false);
    expect(row.text.endsWith('no longer available here')).toBe(true);
  });

  // Must not over-apply: everything that IS a change keeps its own rendering.
  it('leaves an ordinary brokered event on the existing path', () => {
    stubLog([push('applied', 'c9')]);

    const [row] = liveOverviewChanges().changes;
    expect(row.who).toBe('NET-1 · write broker');
    expect(row.text.includes('retention')).toBe(false);
  });

  it('renders a tombstone alongside real changes without displacing them', () => {
    stubLog([tombstone(), push('rejected', 'c2')]);

    const { changes } = liveOverviewChanges();
    expect(changes.length).toBe(2);
    expect(changes[0].who).toBe('retention · write broker');
    expect(changes[1].who).toBe('NET-1 · write broker');
  });
});

/**
 * Which day is "today".
 *
 * The tile decided it with a UTC slice of the clock and compared that against
 * the UTC prefix of each event stamp. Self-consistent, and consistently about
 * the wrong day: west of Greenwich the UTC date rolls over during the
 * afternoon, so the count of the day's pushes reset itself hours before the
 * day ended — beside a per-plane call counter that has always rolled at local
 * midnight, on the same screen.
 */
describe('Configure "Pushed today" and the operator\u2019s calendar', () => {
  const realTz = process.env.TZ;

  afterEach(() => {
    vi.useRealTimers();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  /** Pin the host to `tz` and the clock to that zone's local wall time. */
  function at(tz: string, y: number, mIdx: number, d: number, h: number, min: number): void {
    process.env.TZ = tz;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(y, mIdx, d, h, min, 0));
  }

  it('still counts the afternoon after the UTC date has rolled over', () => {
    // 17:30 in Los Angeles on the 26th is already the 27th in UTC.
    at('America/Los_Angeles', 2026, 6, 26, 17, 30);
    const morning = new Date(2026, 6, 26, 9, 0, 0).toISOString();
    expect(morning.slice(0, 10)).not.toBe(new Date().toISOString().slice(0, 10));

    stubLog([{ ...push('applied', 'c1'), ts: morning }]);
    expect(pushOutcomesToday()).toMatchObject({ applied: 1, total: 1 });
  });

  it('does not sweep yesterday evening into this morning east of Greenwich', () => {
    // 09:00 in Sydney on the 27th is still the 26th in UTC, and so is
    // yesterday evening — a UTC day would count both.
    at('Australia/Sydney', 2026, 6, 27, 9, 0);
    const lastNight = new Date(2026, 6, 26, 20, 0, 0).toISOString();
    const thisMorning = new Date(2026, 6, 27, 8, 0, 0).toISOString();
    expect(lastNight.slice(0, 10)).toBe(thisMorning.slice(0, 10));

    stubLog([
      { ...push('applied', 'c1'), ts: thisMorning },
      { ...push('applied', 'c2'), ts: lastNight },
    ]);
    expect(pushOutcomesToday()).toMatchObject({ applied: 1, total: 1 });
  });
});
