/**
 * web/src/components/FacetFilter.test.tsx — the faceted-filtering contract:
 *  (a) OR within a facet, AND across facets, an empty selection constrains
 *      nothing (applyFacets, the composition helper screens run their rows
 *      through);
 *  (b) counts are honest: an option's count reflects the OTHER active facets,
 *      never its own — ticking one value must not zero its siblings;
 *  (c) a selected value the universe no longer carries stays listed at 0 — a
 *      filter that is hiding rows never becomes invisible;
 *  (d) the popover follows the overlay rules: Escape closes and refocuses the
 *      trigger, a pointer down outside closes;
 *  (e) the per-facet clear and the clear-all chip empty the selection.
 */

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyFacets, FacetFilter, sanitizeFacetSelection } from './FacetFilter';
import type { FacetDef, FacetSelection } from './FacetFilter';

afterEach(cleanup);

type Row = { name: string; plane: string; state: string };

const ROWS: Row[] = [
  { name: 'a', plane: 'CENTRAL', state: 'up' },
  { name: 'b', plane: 'CENTRAL', state: 'down' },
  { name: 'c', plane: 'MIST', state: 'down' },
];

const FACETS: Array<FacetDef<Row>> = [
  { key: 'plane', label: 'Plane', values: (r) => [r.plane] },
  { key: 'state', label: 'State', values: (r) => [r.state] },
];

function Harness({ rows = ROWS }: { rows?: Row[] }) {
  const [selection, setSelection] = useState<FacetSelection>({});
  const filtered = applyFacets(rows, FACETS, selection);
  return (
    <div>
      <FacetFilter facets={FACETS} rows={rows} selection={selection} onChange={setSelection} />
      <ul data-testid="rows">
        {filtered.map((r) => (
          <li key={r.name}>{r.name}</li>
        ))}
      </ul>
    </div>
  );
}

function rowNames(): string {
  return screen.getByTestId('rows').textContent ?? '';
}

describe('applyFacets', () => {
  it('(a) returns the rows unchanged when nothing is ticked', () => {
    expect(applyFacets(ROWS, FACETS, {})).toBe(ROWS);
    expect(applyFacets(ROWS, FACETS, { plane: [] })).toBe(ROWS);
  });

  it('(a) is OR within a facet and AND across facets', () => {
    expect(applyFacets(ROWS, FACETS, { plane: ['CENTRAL', 'MIST'] }).map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(applyFacets(ROWS, FACETS, { plane: ['CENTRAL'] }).map((r) => r.name)).toEqual(['a', 'b']);
    expect(applyFacets(ROWS, FACETS, { plane: ['CENTRAL'], state: ['down'] }).map((r) => r.name)).toEqual(['b']);
  });

  it('(a) matches a multi-valued row on any of its values', () => {
    const multi = [{ name: 'dual', plane: 'CENTRAL', state: 'up', bands: ['2.4', '5'] }];
    const facets: Array<FacetDef<typeof multi[number]>> = [
      { key: 'band', label: 'Band', values: (r) => r.bands },
    ];
    expect(applyFacets(multi, facets, { band: ['5'] })).toHaveLength(1);
    expect(applyFacets(multi, facets, { band: ['6'] })).toHaveLength(0);
  });
});

describe('sanitizeFacetSelection', () => {
  it('keeps string-array entries and drops everything else', () => {
    expect(sanitizeFacetSelection({ plane: ['CENTRAL'], bad: 'x', worse: [1], junk: null })).toEqual({
      plane: ['CENTRAL'],
    });
    expect(sanitizeFacetSelection('nope')).toEqual({});
    expect(sanitizeFacetSelection(['CENTRAL'])).toEqual({});
    expect(sanitizeFacetSelection(undefined)).toEqual({});
  });
});

describe('FacetFilter', () => {
  it('renders one popover trigger per facet, opening on click with live counts', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Plane' }));
    const panel = screen.getByRole('group', { name: 'Plane filter' });
    const central = within(panel).getByRole('checkbox', { name: 'CENTRAL' }).closest('li')!;
    const mist = within(panel).getByRole('checkbox', { name: 'MIST' }).closest('li')!;
    expect(central.textContent).toContain('2');
    expect(mist.textContent).toContain('1');
  });

  it('(b) ticks values with OR-within / AND-across semantics and honest counts', () => {
    render(<Harness />);

    // Ticking a plane narrows the rows (AND across facets)…
    fireEvent.click(screen.getByRole('button', { name: 'Plane' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'CENTRAL' }));
    expect(rowNames()).toBe('ab');
    expect(screen.getByRole('button', { name: 'Plane · 1' })).toBeTruthy();

    // …the plane popover's own counts do NOT collapse on the plane selection…
    const planePanel = screen.getByRole('group', { name: 'Plane filter' });
    expect(within(planePanel).getByRole('checkbox', { name: 'MIST' }).closest('li')!.textContent).toContain('1');

    // …but the OTHER facet's counts reflect it: state counts only CENTRAL rows.
    fireEvent.click(screen.getByRole('button', { name: 'State' }));
    const statePanel = screen.getByRole('group', { name: 'State filter' });
    expect(within(statePanel).getByRole('checkbox', { name: 'up' }).closest('li')!.textContent).toContain('1');
    expect(within(statePanel).getByRole('checkbox', { name: 'down' }).closest('li')!.textContent).toContain('1');

    // AND across facets: plane CENTRAL + state down leaves exactly b.
    fireEvent.click(within(statePanel).getByRole('checkbox', { name: 'down' }));
    expect(rowNames()).toBe('b');

    // OR within a facet: ticking up alongside down widens back to both.
    fireEvent.click(within(statePanel).getByRole('checkbox', { name: 'up' }));
    expect(rowNames()).toBe('ab');
  });

  it('(c) keeps a selected value the universe no longer carries listed at 0', () => {
    render(
      <FacetFilter
        facets={FACETS}
        rows={ROWS}
        selection={{ plane: ['GONE'] }}
        onChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Plane · 1' }));
    const panel = screen.getByRole('group', { name: 'Plane filter' });
    const gone = within(panel).getByRole('checkbox', { name: 'GONE' });
    expect(gone).toHaveProperty('checked', true);
    expect(gone.closest('li')!.textContent).toContain('0');
  });

  it('(d) closes on Escape with focus back on the trigger, and on a pointer down outside', () => {
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Plane' });
    fireEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Plane filter' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Plane filter' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('group', { name: 'Plane filter' })).toBeNull();
  });

  it('(e) clears one facet from its popover and every facet from the clear-all chip', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Plane' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'CENTRAL' }));
    fireEvent.click(screen.getByRole('button', { name: 'State' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'down' }));
    expect(rowNames()).toBe('b');

    // The chip counts the ticked values across every facet.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '2 facet values — clear' })).toBeTruthy();

    // Per-facet clear: the state selection goes, the plane one stays.
    fireEvent.click(screen.getByRole('button', { name: 'State · 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear state' }));
    expect(rowNames()).toBe('ab');
    expect(screen.getByRole('button', { name: '1 facet value — clear' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '1 facet value — clear' }));
    expect(rowNames()).toBe('abc');
    expect(screen.queryByRole('button', { name: /facet value/ })).toBeNull();
  });
});
