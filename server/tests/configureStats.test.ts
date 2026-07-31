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

function stubLog(events: Record<string, unknown>[], unreadable: string[] = []): void {
  vi.spyOn(writeBroker, 'readRecentEvents').mockReturnValue({
    events: events as never,
    unreadable,
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
