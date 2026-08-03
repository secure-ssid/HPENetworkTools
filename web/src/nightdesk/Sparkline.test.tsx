import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Sparkline } from './Sparkline';
import type { MetricPoint } from '@hpe/shared';

afterEach(() => {
  cleanup();
});

const points = (values: number[]): MetricPoint[] =>
  values.map((v, i) => ({ t: new Date(1_700_000_000_000 + i * 300_000).toISOString(), v }));

describe('Sparkline', () => {
  it('draws a polyline across the values, oldest to newest', () => {
    const { container } = render(<Sparkline points={points([1, 3, 2, 5])} label="5 clients · last 24h" />);
    const polyline = container.querySelector('polyline');
    expect(polyline).not.toBeNull();
    const coords = polyline!.getAttribute('points')!.split(' ');
    expect(coords).toHaveLength(4);
    // Even x-spacing, ascending; the max value sits at the top (y smallest).
    const xs = coords.map((c) => Number(c.split(',')[0]));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    const ys = coords.map((c) => Number(c.split(',')[1]));
    expect(ys[1]).toBeLessThan(ys[0]!); // 3 plots above 1
    expect(ys[3]).toBeLessThan(ys[1]!); // 5 is the peak
  });

  it('is decorative to AT — the label is the accessible value', () => {
    const { container } = render(<Sparkline points={points([2, 4])} label="4 attached clients · last 24h" />);
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('img', { name: '4 attached clients · last 24h' })).toBeTruthy();
  });

  it('renders a single sample as one dot, never a two-point fiction', () => {
    const { container } = render(<Sparkline points={points([7])} label="7 clients · 1 sample" />);
    expect(container.querySelector('polyline')).toBeNull();
    expect(container.querySelector('circle')).not.toBeNull();
  });

  it('a flat series of real equal values draws a level line at mid-height', () => {
    const { container } = render(<Sparkline points={points([4, 4, 4])} label="steady" height={18} />);
    const coords = container.querySelector('polyline')!.getAttribute('points')!.split(' ');
    const ys = new Set(coords.map((c) => c.split(',')[1]));
    expect(ys.size).toBe(1);
    expect([...ys][0]).toBe('9.0');
  });

  it('honours an explicit stroke over the accent default', () => {
    const { container } = render(<Sparkline points={points([1, 2])} label="x" stroke="var(--nd-success)" />);
    expect(container.querySelector('polyline')!.getAttribute('stroke')).toBe('var(--nd-success)');
  });

  it('dots a flagged point in the warning tone at its own coordinates', () => {
    const { container } = render(
      <Sparkline points={points([1, 3, 2, 5])} width={96} height={18} label="5 devices · last 24h" markers={[{ index: 3, direction: 'high' }]} />,
    );
    const dots = [...container.querySelectorAll('circle')];
    expect(dots).toHaveLength(1);
    expect(dots[0]!.getAttribute('fill')).toBe('var(--nd-warning)');
    // The flagged point is the peak: last x, top y — the same coordinates
    // the polyline draws it at.
    expect(dots[0]!.getAttribute('cx')).toBe('96.0');
    expect(dots[0]!.getAttribute('cy')).toBe('1.5');
  });

  it('mentions the flags in the accessible label only when there are any', () => {
    render(
      <Sparkline
        points={points([1, 3, 2, 5])}
        label="5 devices · last 24h"
        markers={[{ index: 1 }, { index: 3 }]}
      />,
    );
    expect(screen.getByRole('img', { name: '5 devices · last 24h · 2 points flagged unusual' })).toBeTruthy();
    cleanup();
    render(<Sparkline points={points([1, 3, 2, 5])} label="5 devices · last 24h" />);
    expect(screen.getByRole('img', { name: '5 devices · last 24h' })).toBeTruthy();
  });

  it('an out-of-range marker index renders nothing rather than misplacing a dot', () => {
    const { container } = render(
      <Sparkline points={points([1, 2, 3])} label="x" markers={[{ index: 7 }]} />,
    );
    expect(container.querySelector('circle')).toBeNull();
  });
});
