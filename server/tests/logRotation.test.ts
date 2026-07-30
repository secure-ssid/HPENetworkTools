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
    expect(readJsonlNewestFirst<Row>(file, 10, isRow).map((r) => r.n)).toEqual([3, 2, 1]);
  });

  it('stops at the limit without reading generations it does not need', () => {
    write(generationPath(file, 1), [{ ts: 'a', n: 1 }]);
    write(file, [{ ts: 'b', n: 2 }, { ts: 'c', n: 3 }]);
    expect(readJsonlNewestFirst<Row>(file, 2, isRow).map((r) => r.n)).toEqual([3, 2]);
  });

  it('skips a torn line without hiding the rest of the file', () => {
    writeFileSync(file, `${JSON.stringify({ ts: 'a', n: 1 })}\n{"ts":"b"\n${JSON.stringify({ ts: 'c', n: 3 })}\n`);
    expect(readJsonlNewestFirst<Row>(file, 10, isRow).map((r) => r.n)).toEqual([3, 1]);
  });

  it('rejects entries that fail the caller’s guard', () => {
    writeFileSync(file, `${JSON.stringify({ nope: true })}\n${JSON.stringify({ ts: 'a', n: 1 })}\n`);
    expect(readJsonlNewestFirst<Row>(file, 10, isRow)).toHaveLength(1);
  });

  it('is an empty list, not an error, when nothing has been written', () => {
    expect(readJsonlNewestFirst<Row>(join(dir, 'nope.jsonl'), 10, isRow)).toEqual([]);
  });
});

describe('readLinesNewestFirst', () => {
  it('returns raw lines newest-first across generations, skipping blanks', () => {
    writeFileSync(generationPath(file, 1), 'one\n\ntwo\n');
    writeFileSync(file, 'three\n');
    expect(readLinesNewestFirst(file, 10)).toEqual(['three', 'two', 'one']);
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
    const read = readJsonlNewestFirst<Row>(file, 100, isRow, policy.keep)
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
