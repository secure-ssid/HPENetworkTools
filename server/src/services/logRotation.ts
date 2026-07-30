/**
 * server/src/services/logRotation.ts — bounded append-only files.
 *
 * change-log.jsonl, diagnostics-history.jsonl and the SSH transcripts are
 * append-only and, before this, unbounded. readSession() capped what it *read*
 * but nothing capped what was *written*: a busy install grew a single audit
 * file until the disk it lives on ran out, and the first symptom would have
 * been a failed write to the file whose whole job is to record failures.
 *
 * The design constraint that shapes everything here: **this is an audit
 * trail.** Rotation that quietly drops the oldest generation turns "we have no
 * record of that change" into something indistinguishable from "that change
 * never happened". So:
 *
 *   - Rotation renames; it never truncates in place. A reader that opened the
 *     file keeps reading a coherent one.
 *   - Generations beyond the retention limit are deleted only after a tombstone
 *     naming the file, its size and its time span has been appended to the
 *     live log. The gap is part of the record.
 *   - Readers read across generations (readJsonlNewestFirst), so history does
 *     not appear to shrink the moment a rotation happens.
 *
 * Rotation is checked on write rather than on a timer: no scheduler to own, no
 * behaviour that depends on the process having been up long enough.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface RotationPolicy {
  /** Rotate once the live file is at least this big. */
  maxBytes: number;
  /** How many rotated generations to keep besides the live file. */
  keep: number;
}

export const DEFAULT_POLICY: RotationPolicy = {
  maxBytes: Number(process.env.HPE_LOG_MAX_BYTES) > 0 ? Number(process.env.HPE_LOG_MAX_BYTES) : 16 * 1024 * 1024,
  keep: Number(process.env.HPE_LOG_KEEP) > 0 ? Number(process.env.HPE_LOG_KEEP) : 9,
};

/** `foo.jsonl` → `foo.3.jsonl`. Keeps the extension so tooling still sees JSONL. */
export function generationPath(file: string, n: number): string {
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  return `${stem}.${n}${ext}`;
}

/**
 * Every existing generation of `file`, newest content first: the live file,
 * then .1, .2, … Missing generations are skipped rather than treated as an
 * error — a gap means retention removed one, which the tombstone already
 * records.
 */
export function generations(file: string, keep = DEFAULT_POLICY.keep): string[] {
  const out: string[] = [];
  if (fs.existsSync(file)) out.push(file);
  for (let n = 1; n <= keep; n += 1) {
    const p = generationPath(file, n);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** First and last `ts` in a JSONL file, for the tombstone. Null when unreadable. */
function timeSpan(file: string): { from: string; to: string } | null {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;
    const stamp = (line: string): string | null => {
      try {
        const v = (JSON.parse(line) as { ts?: unknown }).ts;
        return typeof v === 'string' ? v : null;
      } catch {
        return null;
      }
    };
    const from = stamp(lines[0]);
    const to = stamp(lines[lines.length - 1]);
    return from && to ? { from, to } : null;
  } catch {
    return null;
  }
}

/**
 * Rotate `file` if it has grown past the policy, shifting generations up.
 *
 * Returns true when a rotation happened. Errors are reported, never thrown:
 * this runs on the write path of an audit log, and a rotation problem must not
 * be the reason a change goes unrecorded — a too-large log is a much smaller
 * problem than a missing entry.
 */
export function rotateIfNeeded(
  file: string,
  policy: RotationPolicy = DEFAULT_POLICY,
  onError: (msg: string) => void = (m) => console.error(m),
): boolean {
  try {
    if (fileSize(file) < policy.maxBytes) return false;

    // The generation about to fall off the end. Record it before it is gone:
    // a silent deletion makes "no record of that change" look exactly like
    // "that change never happened".
    const oldest = generationPath(file, policy.keep);
    let tombstone: Record<string, unknown> | null = null;
    if (fs.existsSync(oldest)) {
      const span = timeSpan(oldest);
      tombstone = {
        ts: new Date().toISOString(),
        event: 'log-retention',
        result: 'discarded',
        file: path.basename(oldest),
        bytes: fileSize(oldest),
        ...(span ? { coveringFrom: span.from, coveringTo: span.to } : {}),
        note: 'oldest retained generation deleted by retention policy — those entries are no longer available here',
      };
      fs.rmSync(oldest, { force: true });
    }

    for (let n = policy.keep - 1; n >= 1; n -= 1) {
      const from = generationPath(file, n);
      if (fs.existsSync(from)) fs.renameSync(from, generationPath(file, n + 1));
    }
    fs.renameSync(file, generationPath(file, 1));

    if (tombstone) {
      // Into the new live file, so the gap travels with the newest history
      // rather than living only in whatever generation is about to age out.
      fs.appendFileSync(file, JSON.stringify(tombstone) + '\n', { mode: 0o600 });
    }
    return true;
  } catch (err) {
    onError(`log rotation failed for ${file}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Up to `limit` non-blank lines, newest first, across rotated generations.
 *
 * The raw-line form exists for callers that do their own field-by-field
 * validation of each entry (diagnostics history redacts as it parses) and so
 * cannot hand a type guard to readJsonlNewestFirst.
 */
export function readLinesNewestFirst(file: string, limit: number, keep = DEFAULT_POLICY.keep): string[] {
  const out: string[] = [];
  for (const gen of generations(file, keep)) {
    let lines: string[];
    try {
      lines = fs.readFileSync(gen, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      if (lines[i].trim()) out.push(lines[i]);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Read up to `limit` JSONL entries newest-first, across rotated generations.
 *
 * Without this a rotation would make the Change history drawer appear to lose
 * everything that happened before it — the entries are still on disk, and a UI
 * that shows fewer than it could is the same failure as one that shows an
 * unread section as empty.
 *
 * Lines that do not parse are skipped rather than aborting the read: one
 * corrupt line (a torn write during a crash) must not hide the rest.
 */
export function readJsonlNewestFirst<T>(
  file: string,
  limit: number,
  accept: (value: unknown) => value is T,
  keep = DEFAULT_POLICY.keep,
): T[] {
  const out: T[] = [];
  for (const gen of generations(file, keep)) {
    let lines: string[];
    try {
      lines = fs.readFileSync(gen, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (accept(parsed)) out.push(parsed);
      } catch {
        // torn or corrupt line — skip it, keep the rest
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}
