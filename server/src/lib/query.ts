/**
 * server/src/lib/query.ts — shared Express query parsers for list/export routes.
 *
 * Keep filter semantics honest: missing / empty / unknown values are no-ops
 * (return '' or null) rather than inventing defaults that silently change
 * operator-visible row sets. Prefer these over ad-hoc `typeof req.query…`
 * checks so OpenAPI, UI write-back, and route filters stay aligned.
 */

/**
 * Minimal query bag — Express `Request` or a plain `{ query }` test double.
 * Values are unknown so unit tests can pass `Record<string, unknown>` without
 * fighting Express `ParsedQs` variance.
 */
export type QueryBag = { query: Record<string, unknown> };

/** First string query value, trimmed. Missing / non-string → ''. */
export function queryString(req: QueryBag, key: string): string {
  const v = req.query[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Optional boolean-ish flag.
 * - true:  `1` | `true` | `yes` | `on`  (case-insensitive)
 * - false: `0` | `false` | `no` | `off`
 * - null:  missing, empty, or unknown (honest filter no-op)
 */
export function queryFlag(req: QueryBag, key: string): boolean | null {
  const raw = queryString(req, key).toLowerCase();
  if (!raw) return null;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return null;
}

/**
 * Case-insensitive membership in a fixed allow-list.
 * Unknown / empty → null (honest no-op — never coerce to the first enum).
 */
export function queryOneOf<T extends string>(
  req: QueryBag,
  key: string,
  allowed: readonly T[],
): T | null {
  const raw = queryString(req, key).toLowerCase();
  if (!raw) return null;
  for (const a of allowed) {
    if (a.toLowerCase() === raw) return a;
  }
  return null;
}

/**
 * Optional positive integer query param (Loop 108).
 * - null: missing, empty, non-digits, zero/negative, non-safe integer
 * - number: integer ≥ 1, optionally capped by `max`
 *
 * Rejects floats / scientific notation / arrays so garbage never becomes 0
 * or silently changes operator-visible page sizes. Callers apply their own
 * default when the result is null.
 */
export function queryInt(
  req: QueryBag,
  key: string,
  opts?: { max?: number },
): number | null {
  const raw = queryString(req, key);
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  if (opts?.max !== undefined) return Math.min(n, opts.max);
  return n;
}

/**
 * Comma-separated multi-value tokens (Loop 111).
 * Splits on commas, trims, lowercases, drops empties. Missing / non-string → [].
 * Callers treat empty as an honest no-op filter (OR-within-key when non-empty).
 * Used by Alerts facets (`plane`/`sev`/`site`) so list, Load more, and CSV share one parser.
 */
export function queryTokens(req: QueryBag, key: string): string[] {
  const raw = queryString(req, key);
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}
