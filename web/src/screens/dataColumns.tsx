/**
 * web/src/screens/dataColumns.tsx — columns that disappear when they have
 * nothing to say.
 *
 * A wide table is only readable while its columns carry information. In a
 * single-site workspace every client row names the same site, the same plane
 * and the same health; on a healthy access switch every port reports the same
 * spanning-tree role and the same PoE class. Rendered as columns those facts
 * are hundreds of pixels spent repeating one word down the page, and they push
 * the columns that DO differ — the verdict, the outlier — off the right edge.
 *
 * So a column whose every row answers identically is dropped and stated once
 * underneath instead. Nothing is hidden: the fact is still on screen, once,
 * where it is read once. The moment a single row disagrees the column comes
 * back, which is exactly when it starts earning its width.
 *
 * The same collapse StatRow does for a caption every tile shares.
 */
import type { ReactNode } from 'react';

export type DataColumn<T> = {
  /** Header label, and the word used when the column is stated once instead. */
  key: string;
  /**
   * The cell as text. Drives BOTH the identical-value test and the default
   * render, so the two can never disagree. null = the source reported nothing
   * for this row, which is not the same as reporting an empty string.
   */
  value: (row: T) => string | null;
  /** A richer cell (badge, link) when text will not do. Collapsing still
   *  keys on value(), because that is what the reader compares. */
  render?: (row: T) => ReactNode;
  numeric?: boolean;
  mono?: boolean;
  nowrap?: boolean;
};

/**
 * Split columns into the ones worth rendering and the facts to state once.
 *
 * A set smaller than `minRows` is never collapsed: with two rows "they agree"
 * is a coincidence, not a property of the data, and a column that vanishes on
 * a short list and returns on a long one is more confusing than the repetition
 * it saves. A column no row answers at all is dropped silently — there is
 * neither a column to show nor a fact to state.
 */
export function partitionColumns<T>(
  rows: T[],
  columns: Array<DataColumn<T>>,
  minRows = 3,
): { shown: Array<DataColumn<T>>; shared: string[] } {
  const shown: Array<DataColumn<T>> = [];
  const shared: string[] = [];
  const collapsible = rows.length >= minRows;

  for (const column of columns) {
    const values = rows.map(column.value);
    const distinct = new Set(values.map((value) => value ?? ''));
    if (distinct.size === 1 && distinct.has('')) continue;
    if (collapsible && distinct.size === 1) {
      shared.push(`${column.key} ${values[0] as string}`);
      continue;
    }
    shown.push(column);
  }

  return { shown, shared };
}

/** The collapsed columns, stated once under the table they came out of. */
export function SharedFacts({ facts, count, noun }: { facts: string[]; count: number; noun: string }) {
  if (facts.length === 0) return null;
  return (
    <p className="nt-table-shared">
      Same on all {count} {noun}: {facts.join(' · ')}
    </p>
  );
}
