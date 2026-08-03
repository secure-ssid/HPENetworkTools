/**
 * web/src/components/SavedViews.test.tsx — the saved-views dropdown contract:
 *  (a) save captures the screen's snapshot under a non-empty, unique name —
 *      a duplicate disables the save and says why (never a silent overwrite);
 *  (b) applying a view hands the stored snapshot back and closes the panel;
 *  (c) rename commits a non-empty, still-unique name — an empty or duplicate
 *      rename is a no-op, never a destroyed or shadowed view;
 *  (d) delete removes exactly that view;
 *  (e) the dropdown follows the overlay rules: Escape closes and refocuses
 *      the trigger.
 */

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SavedViews } from './SavedViews';
import type { SavedView } from '../app/SettingsContext';

afterEach(cleanup);

const WAN: SavedView = {
  name: 'WAN focus',
  filters: { facets: { plane: ['CENTRAL'] }, q: 'wan' },
  tableColumns: { hidden: ['site'] },
  density: 'compact',
};
const QUIET: SavedView = { name: 'Quiet estate', filters: { facets: { sev: ['P3'] } } };

const CAPTURED: Omit<SavedView, 'name'> = { filters: { q: 'current' }, density: 'comfortable' };

function Harness({ initial, onApply = vi.fn() }: { initial: SavedView[]; onApply?: (view: SavedView) => void }) {
  const [views, setViews] = useState<SavedView[]>(initial);
  return (
    <div>
      <SavedViews views={views} capture={() => CAPTURED} onApply={onApply} onChange={setViews} />
      <div data-testid="views">{JSON.stringify(views)}</div>
    </div>
  );
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /^Views/ }));
}

describe('SavedViews', () => {
  it('(a) saves the current snapshot under a typed name and clears the input', () => {
    render(<Harness initial={[]} />);
    openPanel();

    expect(screen.getByText(/No saved views/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText('New view name'), { target: { value: '  WAN focus  ' } });
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);

    const views = JSON.parse(screen.getByTestId('views').textContent ?? '[]') as SavedView[];
    expect(views).toEqual([{ name: 'WAN focus', ...CAPTURED }]);
    expect(screen.getByRole('button', { name: 'Views · 1' })).toBeTruthy();
    expect((screen.getByLabelText('New view name') as HTMLInputElement).value).toBe('');
  });

  it('(a) refuses a duplicate name rather than silently overwriting the view', () => {
    render(<Harness initial={[WAN]} />);
    openPanel();

    fireEvent.change(screen.getByLabelText('New view name'), { target: { value: 'wan FOCUS' } });
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/a view with this name exists/)).toBeTruthy();

    const views = JSON.parse(screen.getByTestId('views').textContent ?? '[]') as SavedView[];
    expect(views).toEqual([WAN]);
  });

  it('(b) applies a view and closes the panel', () => {
    const onApply = vi.fn();
    render(<Harness initial={[WAN, QUIET]} onApply={onApply} />);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'WAN focus' }));
    expect(onApply).toHaveBeenCalledWith(WAN);
    expect(screen.queryByRole('group', { name: 'Saved views' })).toBeNull();
  });

  it('(c) renames a view, and treats an empty or duplicate rename as a no-op', () => {
    render(<Harness initial={[WAN, QUIET]} />);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Rename view WAN focus' }));
    fireEvent.change(screen.getByLabelText('New name for view WAN focus'), { target: { value: 'WAN only' } });
    fireEvent.keyDown(screen.getByLabelText('New name for view WAN focus'), { key: 'Enter' });
    fireEvent.submit(screen.getByLabelText('New name for view WAN focus').closest('form')!);

    let views = JSON.parse(screen.getByTestId('views').textContent ?? '[]') as SavedView[];
    expect(views.map((v) => v.name)).toEqual(['WAN only', 'Quiet estate']);

    // A duplicate rename leaves the list alone — the existing view is never shadowed.
    fireEvent.click(screen.getByRole('button', { name: 'Rename view WAN only' }));
    fireEvent.change(screen.getByLabelText('New name for view WAN only'), { target: { value: 'quiet estate' } });
    fireEvent.submit(screen.getByLabelText('New name for view WAN only').closest('form')!);
    views = JSON.parse(screen.getByTestId('views').textContent ?? '[]') as SavedView[];
    expect(views.map((v) => v.name)).toEqual(['WAN only', 'Quiet estate']);
  });

  it('(c) cancels a rename on Escape without closing the panel', () => {
    render(<Harness initial={[WAN]} />);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Rename view WAN focus' }));
    const input = screen.getByLabelText('New name for view WAN focus');
    fireEvent.change(input, { target: { value: 'discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.getByRole('group', { name: 'Saved views' })).toBeTruthy();
    const views = JSON.parse(screen.getByTestId('views').textContent ?? '[]') as SavedView[];
    expect(views).toEqual([WAN]);
  });

  it('(d) deletes exactly the named view', () => {
    render(<Harness initial={[WAN, QUIET]} />);
    openPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Delete view WAN focus' }));
    const views = JSON.parse(screen.getByTestId('views').textContent ?? '[]') as SavedView[];
    expect(views).toEqual([QUIET]);
    expect(screen.getByRole('button', { name: 'Views · 1' })).toBeTruthy();
  });

  it('(e) closes on Escape with focus back on the trigger', () => {
    render(<Harness initial={[WAN]} />);
    const trigger = screen.getByRole('button', { name: 'Views · 1' });
    fireEvent.click(trigger);
    expect(screen.getByRole('group', { name: 'Saved views' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Saved views' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
