/**
 * server/tests/logRotation.test.ts — bounding an audit trail without losing it.
 *
 * The interesting cases are all about what rotation must NOT do: lose entries
 * a reader could still have shown, delete a generation without saying so, or
 * fail a write because rotation had a problem. A too-large log is a much
 * smaller problem than a missing change record.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generationPath,
  generations,
  readJsonlNewestFirst,
  readLinesNewestFirst,
  rotateIfNeeded,
} from '../src/services/logRotation';

let dir: string;
let file: string;

interface Row {
  ts: string;
  n: number;
}
const isRow = (v: unknown): v is Row =>
  typeof v === 'object' && v !== null && typeof (v as Row).ts === 'string';

function write(target: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(target, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hpe-rot-'));
  file = join(dir, 'change-log.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('generationPath', () => {
  it('keeps the extension so tooling still sees JSONL', () => {
    expect(generationPath('/d/change-log.jsonl', 3)).toBe('/d/change-log.3.jsonl');
  });
});

describe('rotateIfNeeded', () => {
  it('does nothing while the file is under the limit', () => {
    write(file, [{ ts: 'a', n: 1 }]);
    expect(rotateIfNeeded(file, { maxBytes: 10_000, keep: 3 })).toBe(false);
    expect(existsSync(generationPath(file, 1))).toBe(false);
  });

  it('renames rather than truncating, so nothing is lost', () => {
    write(file, [{ ts: 'a', n: 1 }, { ts: 'b', n: 2 }]);
    const before = readFileSync(file, 'utf8');
    expect(rotateIfNeeded(file, { maxBytes: 10, keep: 3 })).toBe(true);
    expect(existsSync(file)).toBe(false); // nothing new written yet
    expect(readFileSync(generationPath(file, 1), 'utf8')).toBe(before);
  });

  it('shifts generations up', () => {
    write(generationPath(file, 1), [{ ts: 'old-1', n: 1 }]);
    write(file, [{ ts: 'live', n: 9 }]);
    rotateIfNeeded(file, { maxBytes: 1, keep: 3 });
    expect(readFileSync(generationPath(file, 1), 'utf8')).toContain('live');
    expect(readFileSync(generationPath(file, 2), 'utf8')).toContain('old-1');
  });

  it('records a tombstone when retention discards the oldest generation', () => {
    // A silent deletion makes "we have no record of that change" look exactly
    // like "that change never happened".
    write(generationPath(file, 2), [{ ts: '2026-01-01T00:00:00Z', n: 1 }, { ts: '2026-01-02T00:00:00Z', n: 2 }]);
    write(file, [{ ts: '2026-03-01T00:00:00Z', n: 3 }]);
    rotateIfNeeded(file, { maxBytes: 1, keep: 2 });

    expect(existsSync(generationPath(file, 3))).toBe(false);
    const live = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      event: 'log-retention',
      result: 'discarded',
      file: 'change-log.2.jsonl',
      coveringFrom: '2026-01-01T00:00:00Z',
      coveringTo: '2026-01-02T00:00:00Z',
    });
  });

  it('writes no tombstone when nothing was discarded', () => {
    write(file, [{ ts: 'a', n: 1 }]);
    rotateIfNeeded(file, { maxBytes: 1, keep: 3 });
    expect(existsSync(file)).toBe(false);
  });

  it('reports a rotation failure instead of throwing into the write path', () => {
    // appendBrokerLog calls this; a rotation problem must never be the reason a
    // change goes unrecorded. A read-only directory is the realistic version:
    // the rename cannot happen, and the caller must still get to append.
    const errors: string[] = [];
    const sub = join(dir, 'ro');
    mkdirSync(sub);
    const target = join(sub, 'change-log.jsonl');
    write(target, [{ ts: 'a', n: 1 }]);
    chmodSync(sub, 0o500);
    try {
      expect(rotateIfNeeded(target, { maxBytes: 1, keep: 3 }, (m) => errors.push(m))).toBe(false);
      expect(errors[0]).toContain('log rotation failed');
      expect(existsSync(target)).toBe(true); // the live log is still there
    } finally {
      chmodSync(sub, 0o700);
    }
  });

  it('is a no-op for a file that does not exist yet', () => {
    expect(rotateIfNeeded(join(dir, 'nope.jsonl'), { maxBytes: 1, keep: 3 })).toBe(false);
  });
});

describe('generations', () => {
  it('lists the live file first, then each rotated one that exists', () => {
    write(file, [{ ts: 'live', n: 0 }]);
    write(generationPath(file, 1), [{ ts: 'g1', n: 1 }]);
    write(generationPath(file, 3), [{ ts: 'g3', n: 3 }]);
    expect(generations(file, 4)).toEqual([file, generationPath(file, 1), generationPath(file, 3)]);
  });
});

describe('readJsonlNewestFirst', () => {
  it('reads across generations so history does not appear to shrink', () => {
    write(generationPath(file, 1), [{ ts: 'a', n: 1 }, { ts: 'b', n: 2 }]);
    write(file, [{ ts: 'c', n: 3 }]);
    expect(readJsonlNewestFirst<Row>(file, 10, isRow).entries.map((r) => r.n)).toEqual([3, 2, 1]);
  });

  it('stops at the limit without reading generations it does not need', () => {
    write(generationPath(file, 1), [{ ts: 'a', n: 1 }]);
    write(file, [{ ts: 'b', n: 2 }, { ts: 'c', n: 3 }]);
    expect(readJsonlNewestFirst<Row>(file, 2, isRow).entries.map((r) => r.n)).toEqual([3, 2]);
  });

  it('skips a torn line without hiding the rest of the file', () => {
    writeFileSync(file, `${JSON.stringify({ ts: 'a', n: 1 })}\n{"ts":"b"\n${JSON.stringify({ ts: 'c', n: 3 })}\n`);
    expect(readJsonlNewestFirst<Row>(file, 10, isRow).entries.map((r) => r.n)).toEqual([3, 1]);
  });

  it('rejects entries that fail the caller’s guard', () => {
    writeFileSync(file, `${JSON.stringify({ nope: true })}\n${JSON.stringify({ ts: 'a', n: 1 })}\n`);
    expect(readJsonlNewestFirst<Row>(file, 10, isRow).entries).toHaveLength(1);
  });

  it('is an empty list, not an error, when nothing has been written', () => {
    expect(readJsonlNewestFirst<Row>(join(dir, 'nope.jsonl'), 10, isRow)).toEqual({
      entries: [],
      unreadable: [],
      truncated: false,
    });
  });
});

/**
 * The cap.
 *
 * `unreadable` was added because a generation that will not open makes the
 * read come back short, and a short read looks exactly like a quiet period.
 * The limit does the same thing for no reason at all — no permission problem,
 * no bad sector, just more history than the caller asked for — and it was the
 * one cause of a short read that said nothing. Callers that take a window
 * (the four most recent changes) do not care. Callers that COUNT — pushes
 * today, a ticket's evidence trail — were reporting a floor as a total.
 */
describe('a read that stopped at its limit says so', () => {
  it('reports truncation when an entry existed past the limit', () => {
    write(file, [{ ts: 'a', n: 1 }, { ts: 'b', n: 2 }, { ts: 'c', n: 3 }]);
    const read = readJsonlNewestFirst<Row>(file, 2, isRow);
    expect(read.entries.map((r) => r.n)).toEqual([3, 2]);
    expect(read.truncated).toBe(true);
  });

  it('does not cry truncation over a read that ended exactly on the limit', () => {
    // A false caveat is its own dishonesty: it tells an operator the record
    // has a hole in it when the record is whole.
    write(file, [{ ts: 'a', n: 1 }, { ts: 'b', n: 2 }]);
    expect(readJsonlNewestFirst<Row>(file, 2, isRow).truncated).toBe(false);
  });

  it('finds the proof in the next generation when the live file ends on the limit', () => {
    // The evidence that something was left behind is not always in the file
    // the read filled up on.
    write(generationPath(file, 1), [{ ts: 'a', n: 1 }]);
    write(file, [{ ts: 'b', n: 2 }, { ts: 'c', n: 3 }]);
    expect(readJsonlNewestFirst<Row>(file, 2, isRow).truncated).toBe(true);
  });

  it('does not count trailing junk as history that was left behind', () => {
    // A torn line past the limit is not an entry this caller would have
    // returned, so it is not a gap in what this caller reads.
    writeFileSync(file, `{"ts":"torn"\n${JSON.stringify({ ts: 'b', n: 2 })}\n${JSON.stringify({ ts: 'c', n: 3 })}\n`);
    const read = readJsonlNewestFirst<Row>(file, 2, isRow);
    expect(read.entries.map((r) => r.n)).toEqual([3, 2]);
    expect(read.truncated).toBe(false);
  });

  it('applies the same rule to the raw-line reader', () => {
    writeFileSync(file, 'one\n\ntwo\nthree\n');
    expect(readLinesNewestFirst(file, 3).truncated).toBe(false);
    const capped = readLinesNewestFirst(file, 2);
    expect(capped.entries).toEqual(['three', 'two']);
    expect(capped.truncated).toBe(true);
  });
});

describe('readLinesNewestFirst', () => {
  it('returns raw lines newest-first across generations, skipping blanks', () => {
    writeFileSync(generationPath(file, 1), 'one\n\ntwo\n');
    writeFileSync(file, 'three\n');
    expect(readLinesNewestFirst(file, 10).entries).toEqual(['three', 'two', 'one']);
  });
});

describe('rotation end to end', () => {
  it('keeps every entry readable across several rotations', () => {
    const policy = { maxBytes: 60, keep: 4 };
    const seen: number[] = [];
    for (let n = 1; n <= 12; n += 1) {
      rotateIfNeeded(file, policy);
      appendFileSync(file, JSON.stringify({ ts: `t${n}`, n }) + '\n');
      seen.push(n);
    }
    const read = readJsonlNewestFirst<Row>(file, 100, isRow, policy.keep).entries
      .filter((r) => typeof r.n === 'number')
      .map((r) => r.n);
    // Some of the oldest may have aged out — but every one still on disk must
    // be readable, and they must come back newest-first with no gaps in the
    // retained range.
    expect(read.length).toBeGreaterThan(0);
    expect(read).toEqual([...read].sort((a, b) => b - a));
    expect(read[0]).toBe(12);
    for (let i = 1; i < read.length; i += 1) expect(read[i]).toBe(read[i - 1] - 1);
    // And the live file stayed bounded.
    expect(statSync(file).size).toBeLessThan(policy.maxBytes * 2);
  });
});

/**
 * An unreadable generation.
 *
 * This module is careful about a generation it *deletes* — retention writes a
 * tombstone first, so the gap is part of the record. It was silent about a
 * generation it simply could not open. That is the worse of the two: the read
 * comes back short, continuous, and plausible, and the caller has no way to
 * tell a quiet period from an unreachable one.
 *
 * A directory in the generation's place is used rather than chmod, because
 * chmod 000 does not stop a root-owned test runner from reading the file and
 * the assertion has to hold everywhere.
 */
describe('a generation that exists but cannot be read', () => {
  it('names it instead of passing it off as absent', () => {
    write(file, [{ ts: 'c', n: 3 }]);
    write(generationPath(file, 2), [{ ts: 'a', n: 1 }]);
    mkdirSync(generationPath(file, 1)); // exists; readFileSync throws EISDIR

    const read = readJsonlNewestFirst<Row>(file, 10, isRow);
    // The readable generations still come back — a partial answer beats none.
    expect(read.entries.map((r) => r.n)).toEqual([3, 1]);
    // ...but the hole between them is stated, not swallowed.
    expect(read.unreadable).toEqual(['change-log.1.jsonl']);
  });

  it('reports nothing unreadable when every generation opens', () => {
    write(generationPath(file, 1), [{ ts: 'a', n: 1 }]);
    write(file, [{ ts: 'b', n: 2 }]);

    const read = readJsonlNewestFirst<Row>(file, 10, isRow);
    expect(read.entries.map((r) => r.n)).toEqual([2, 1]);
    // An aged-out generation is a genuine absence and must not be reported as
    // a failure — generations() skips it by existence, which is correct.
    expect(read.unreadable).toEqual([]);
  });

  it('distinguishes an unreadable log from one that was never written', () => {
    // Nothing on disk at all: the caller's "nothing has been brokered here"
    // empty state is the honest reading.
    expect(readJsonlNewestFirst<Row>(file, 10, isRow)).toEqual({
      entries: [],
      unreadable: [],
      truncated: false,
    });

    // The live file exists and cannot be read: same empty list, opposite
    // meaning. Only `unreadable` tells them apart.
    mkdirSync(file);
    const read = readJsonlNewestFirst<Row>(file, 10, isRow);
    expect(read.entries).toEqual([]);
    expect(read.unreadable).toEqual(['change-log.jsonl']);
  });

  it('reports it from the raw-line reader too, which diagnostics history uses', () => {
    write(file, [{ ts: 'b', n: 2 }]);
    mkdirSync(generationPath(file, 1));

    const read = readLinesNewestFirst(file, 10);
    expect(read.entries).toHaveLength(1);
    expect(read.unreadable).toEqual(['change-log.1.jsonl']);
  });

  it('stops at the entry past the limit, so deeper generations are not falsely blamed', () => {
    // The live file itself proves there is more behind the limit, so the read
    // ends there and never touches the rotated generation. Blaming a file it
    // had no reason to open would be its own lie.
    write(file, [{ ts: 'a', n: 1 }, { ts: 'b', n: 2 }, { ts: 'c', n: 3 }]);
    mkdirSync(generationPath(file, 1));

    const read = readJsonlNewestFirst<Row>(file, 2, isRow);
    expect(read.entries.map((r) => r.n)).toEqual([3, 2]);
    expect(read.unreadable).toEqual([]);
    expect(read.truncated).toBe(true);
  });

  it('names the generation it had to open to answer whether anything was left behind', () => {
    // The limit lands exactly on the live file's last entry, so whether the
    // history goes further is a question only the next generation can answer
    // — and it will not open. Previously the read stopped here and reported a
    // clean, complete-looking result. "I could not tell" and "there was
    // nothing more" are opposite claims, and `unreadable` is where the first
    // one is already said.
    write(file, [{ ts: 'b', n: 2 }, { ts: 'c', n: 3 }]);
    mkdirSync(generationPath(file, 1));

    const read = readJsonlNewestFirst<Row>(file, 2, isRow);
    expect(read.entries.map((r) => r.n)).toEqual([3, 2]);
    expect(read.unreadable).toEqual(['change-log.1.jsonl']);
  });
});
