/**
 * web/src/components/SavedViews.tsx — named saved views for a screen's filter
 * row: save the current filters and table layout under a name, apply one
 * later, rename or delete it. A view captures whatever the screen hands
 * capture() — conventionally its facet selection, free text and switches in
 * `filters`, the DataTable column-manager config in `tableColumns`, and the
 * shell `density`; applying one hands the stored copy back through onApply
 * and the screen restores every piece.
 *
 * Strictly controlled: the screen owns the list (persisted through
 * SettingsContext under its screen id — localStorage first, server sync when
 * the backend answers), so this component holds no view state of its own and
 * every mutation round-trips the store. The store sanitizes names/filters on
 * load; this component enforces the two rules that keep the list legible at
 * write time: a view needs a non-empty name, and names are unique
 * (case-insensitive) — a silent overwrite would destroy a view the operator
 * meant to keep, so a duplicate name disables the save and says why.
 *
 * URL-driven deep links (Devices' ?names=/ ?state=) are deliberately NOT
 * captured: those filters belong to the address that explains them, and a
 * saved copy could drift from it.
 *
 * The dropdown follows the repo's overlay rules without a library: Escape
 * closes and returns focus to the trigger, a pointer down outside closes —
 * the same pattern nightdesk/TableViewOptions.tsx documents, reusing the
 * nd-viewopts classes.
 */

import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '../nightdesk';
import type { SavedView } from '../app/SettingsContext';

export function SavedViews({
  views,
  capture,
  onApply,
  onChange,
}: {
  /** The screen's saved views (controlled, from SettingsContext). */
  views: SavedView[];
  /** Snapshot the screen's current filters + layout, minus the name. */
  capture: () => Omit<SavedView, 'name'>;
  /** Restore a view's captured filters + layout. */
  onApply: (view: SavedView) => void;
  /** Persist a new list (save / rename / delete). */
  onChange: (views: SavedView[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const trimmed = name.trim();
  const nameTaken = views.some((view) => view.name.toLowerCase() === trimmed.toLowerCase());

  const save = () => {
    if (!trimmed || nameTaken) return;
    onChange([...views, { name: trimmed, ...capture() }]);
    setName('');
  };

  const commitRename = (from: string) => {
    const next = renameValue.trim();
    setRenaming(null);
    // An empty or duplicate rename is a no-op, never a destroyed or shadowed
    // view: the old name stays, and the operator's list is unchanged.
    if (!next || next === from) return;
    if (views.some((view) => view.name !== from && view.name.toLowerCase() === next.toLowerCase())) return;
    onChange(views.map((view) => (view.name === from ? { ...view, name: next } : view)));
  };

  return (
    <div className="nd-viewopts" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="nd-btn nd-btn--secondary nd-btn--sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Views{views.length > 0 ? ` · ${views.length}` : ''}
      </button>
      {open ? (
        /* Left-anchored: filter-row triggers sit mid-row, where the
           nd-viewopts right anchor would overflow the viewport edge. */
        <div
          className="nd-viewopts__panel"
          role="group"
          aria-label="Saved views"
          style={{ right: 'auto', left: 0, minWidth: 260 }}
        >
          <div className="nd-viewopts__heading">Saved views</div>
          {views.length === 0 ? (
            <div
              style={{
                padding: '2px 6px 8px',
                fontSize: 'var(--nd-text-12)',
                color: 'var(--nd-text-muted)',
                lineHeight: 1.5,
              }}
            >
              No saved views — name the current filters and layout below to keep them.
            </div>
          ) : (
            <ul className="nd-viewopts__list">
              {views.map((view) => (
                <li key={view.name} className="nd-viewopts__item">
                  {renaming === view.name ? (
                    <form
                      style={{ display: 'flex', flex: 1, gap: 4, minWidth: 0 }}
                      onSubmit={(event) => {
                        event.preventDefault();
                        commitRename(view.name);
                      }}
                    >
                      <Input
                        size="sm"
                        mono
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            setRenaming(null);
                          }
                        }}
                        aria-label={`New name for view ${view.name}`}
                        autoFocus
                      />
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          onApply(view);
                          setOpen(false);
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: 'var(--nd-text-12)',
                          color: 'var(--nd-text-primary)',
                        }}
                      >
                        {view.name}
                      </button>
                      <span className="nd-viewopts__moves">
                        <button
                          type="button"
                          className="nd-viewopts__move"
                          aria-label={`Rename view ${view.name}`}
                          onClick={() => {
                            setRenaming(view.name);
                            setRenameValue(view.name);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="nd-viewopts__move"
                          aria-label={`Delete view ${view.name}`}
                          onClick={() => onChange(views.filter((v) => v.name !== view.name))}
                        >
                          ×
                        </button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form
            style={{
              display: 'flex',
              gap: 6,
              marginTop: 8,
              paddingTop: 8,
              borderTop: '1px solid var(--nd-border-default)',
            }}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <Input
                size="sm"
                mono
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="name this view…"
                aria-label="New view name"
              />
            </div>
            <Button variant="primary" size="sm" type="submit" disabled={!trimmed || nameTaken}>
              Save
            </Button>
          </form>
          {nameTaken ? (
            <div
              style={{
                padding: '6px 6px 0',
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              a view with this name exists — pick another name, or rename or delete it first
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
