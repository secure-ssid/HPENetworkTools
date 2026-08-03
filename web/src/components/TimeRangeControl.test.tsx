/**
 * web/src/components/TimeRangeControl.test.tsx — the quick-range control.
 *
 * Covered:
 *  (a) the control is strictly controlled — it marks the option the parent
 *      passed and only reports clicks, never moving its own selection;
 *  (b) ?range= parsing: a known value survives, anything else — absent,
 *      typo'd, empty — reads as 'all' so a bad link cannot silently hide
 *      every row;
 *  (c) withinTimeRange membership, including the two edges that decide
 *      honestly: exactly-on-the-cutoff is inside, and an undated row always
 *      passes (it cannot be placed in a window it was never dated against).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TIME_RANGE_MS,
  TimeRangeControl,
  timeRangeForParam,
  withinTimeRange,
} from './TimeRangeControl';

afterEach(cleanup);

describe('TimeRangeControl', () => {
  it('(a) marks exactly the selected range and reports the one clicked', () => {
    const onValueChange = vi.fn();
    render(<TimeRangeControl value="1h" onValueChange={onValueChange} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['15m', '1h', '24h', '7d', 'All']);
    expect(screen.getByRole('tab', { name: '1h' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: '24h' }).getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('tab', { name: '24h' }));
    expect(onValueChange).toHaveBeenCalledWith('24h');
    // Controlled: the click alone must not move the selection.
    expect(screen.getByRole('tab', { name: '1h' }).getAttribute('aria-selected')).toBe('true');
  });

  it('(a) names the group for assistive tech, overridable by the screen', () => {
    render(<TimeRangeControl value="all" onValueChange={() => {}} ariaLabel="Auth window" />);
    expect(screen.getByRole('tablist', { name: 'Auth window' })).toBeTruthy();
  });
});

describe('timeRangeForParam', () => {
  it('(b) passes a known range through and reads anything else as all', () => {
    expect(timeRangeForParam('15m')).toBe('15m');
    expect(timeRangeForParam('7d')).toBe('7d');
    expect(timeRangeForParam('all')).toBe('all');
    expect(timeRangeForParam(null)).toBe('all');
    expect(timeRangeForParam('')).toBe('all');
    expect(timeRangeForParam('24')).toBe('all');
    expect(timeRangeForParam('ALL')).toBe('all');
  });
});

describe('withinTimeRange', () => {
  const NOW = new Date('2026-07-26T12:00:00Z').getTime();

  it('(c) all passes every row, dated or not', () => {
    expect(withinTimeRange(undefined, 'all', NOW)).toBe(true);
    expect(withinTimeRange('2020-01-01T00:00:00Z', 'all', NOW)).toBe(true);
  });

  it('(c) keeps an instant inside the window and drops one older than it', () => {
    const inside = new Date(NOW - TIME_RANGE_MS['15m'] + 1).toISOString();
    const outside = new Date(NOW - TIME_RANGE_MS['15m'] - 1).toISOString();
    expect(withinTimeRange(inside, '15m', NOW)).toBe(true);
    expect(withinTimeRange(outside, '15m', NOW)).toBe(false);
  });

  it('(c) counts an instant exactly on the cutoff as inside', () => {
    const onTheCutoff = new Date(NOW - TIME_RANGE_MS['24h']).toISOString();
    expect(withinTimeRange(onTheCutoff, '24h', NOW)).toBe(true);
  });

  it('(c) never excludes a row that carries no usable timestamp', () => {
    expect(withinTimeRange(undefined, '15m', NOW)).toBe(true);
    expect(withinTimeRange('not-a-date', '7d', NOW)).toBe(true);
  });
});
