/**
 * web/src/components/TimeRangeControl.tsx — quick time ranges as one control.
 *
 * The 15m / 1h / 24h / 7d / All picker every time-bounded screen would
 * otherwise grow its own copy of, built on the nightdesk SegmentedControl so
 * it looks and keys like the pickers already in the headers. Strictly
 * controlled: the parent owns the value (the Auth events screen keeps it in
 * the URL as ?range=, so a narrowed view is shareable) and the control only
 * reports changes.
 *
 * The helpers beside it are the control's whole contract with a screen:
 * `timeRangeForParam` reads the deep-link param back (anything unrecognised
 * is 'all' — a typo'd range must not silently hide every row), and
 * `withinTimeRange` decides one row's membership. A row with no timestamp
 * cannot be placed in ANY window honestly, so it always passes — excluding
 * it would claim it is old, and it is the caller's job to say next to the
 * table how many rows that caveat covers.
 */

import { SegmentedControl } from '../nightdesk';

export type TimeRange = '15m' | '1h' | '24h' | '7d' | 'all';

export const TIME_RANGE_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: 'all', label: 'All' },
];

/** Window each quick range covers, ending now; 'all' has no cutoff. */
export const TIME_RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

/** Range for a `?range=` deep-link param; absent or unrecognised reads as 'all'. */
export function timeRangeForParam(param: string | null): TimeRange {
  return TIME_RANGE_OPTIONS.some((o) => o.value === param) ? (param as TimeRange) : 'all';
}

/**
 * True when the instant `at` (ISO) falls inside the range ending at nowMs.
 * 'all' passes everything; a missing or unparseable instant also passes —
 * an undated row cannot be excluded from a window it was never dated against
 * (see the file header for who says so in the UI).
 */
export function withinTimeRange(at: string | undefined, range: TimeRange, nowMs: number): boolean {
  if (range === 'all') return true;
  if (!at) return true;
  const ms = new Date(at).getTime();
  if (Number.isNaN(ms)) return true;
  return ms >= nowMs - TIME_RANGE_MS[range];
}

export function TimeRangeControl({
  value,
  onValueChange,
  ariaLabel = 'Time range',
}: {
  value: TimeRange;
  onValueChange: (range: TimeRange) => void;
  ariaLabel?: string;
}) {
  return (
    <SegmentedControl
      options={TIME_RANGE_OPTIONS}
      value={value}
      onValueChange={(v) => onValueChange(v as TimeRange)}
      ariaLabel={ariaLabel}
    />
  );
}

export default TimeRangeControl;
