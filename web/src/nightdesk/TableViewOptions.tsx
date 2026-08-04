/**
 * web/src/nightdesk/TableViewOptions.tsx — the 'View options' dropdown: the
 * column manager's UI half. DataTable owns the mechanics (it renders whatever
 * the controlled config says); this is the small popover a screen places near
 * its table so the operator can change that config — show/hide a column,
 * move it up or down, reset everything.
 *
 * Pure controlled component: it reads `columns` + `config` and reports every
 * change through `onChange`. It holds no column state of its own, so the
 * screen's persistence (SettingsContext) stays the single source of truth.
 * Reorder uses explicit ↑/↓ buttons rather than drag — keyboard-operable and
 * honest about what changed; resize deliberately lives on the header edge,
 * not in here.
 *
 * The popover follows the repo's overlay rules without pulling in a library:
 * Escape closes and returns focus to the trigger, a pointer down outside
 * closes, and the trigger advertises its expanded state.
 */

import { useEffect, useRef, useState } from 'react';
import type { DataTableColumn, TableColumnsConfig } from './DataTable';
import { arrangeColumns } from './DataTable';
import { cx } from './utils';

export function TableViewOptions<Row>({
  columns,
  config,
  onChange,
}: {
  /** The table's full column definitions (hidden ones included). */
  columns: Array<DataTableColumn<Row>>;
  /** The controlled config the table is rendering. */
  config: TableColumnsConfig;
  onChange: (config: TableColumnsConfig) => void;
}) {
  const [open, setOpen] = useState(false);
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

  const arranged = arrangeColumns(columns, config);
  const hidden = new Set(config.hidden ?? []);
  const visibleCount = arranged.filter((column) => !hidden.has(column.key) || column.hideable === false).length;

  const toggle = (column: DataTableColumn<Row>) => {
    const nextHidden = new Set(hidden);
    if (nextHidden.has(column.key)) nextHidden.delete(column.key);
    else nextHidden.add(column.key);
    // Rebuild from the arranged set so keys the code no longer defines drop
    // out of the persisted config instead of accumulating.
    onChange({
      ...config,
      hidden: arranged.filter((c) => nextHidden.has(c.key)).map((c) => c.key),
    });
  };

  const move = (column: DataTableColumn<Row>, direction: -1 | 1) => {
    const keysOrder = arranged.map((c) => c.key);
    const from = keysOrder.indexOf(column.key);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= keysOrder.length) return;
    [keysOrder[from], keysOrder[to]] = [keysOrder[to] as string, keysOrder[from] as string];
    onChange({ ...config, order: keysOrder });
  };

  const isDefault =
    (config.order?.length ?? 0) === 0 &&
    (config.hidden?.length ?? 0) === 0 &&
    Object.keys(config.widths ?? {}).length === 0;

  return (
    <div className="nd-viewopts nt-view-options" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="nd-btn nd-btn--secondary nd-btn--sm nt-btn"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        View options
      </button>
      {open ? (
        <div className="nd-viewopts__panel nt-panel-glass nt-view-options__panel" role="group" aria-label="Table view options">
          <div className="nd-viewopts__heading nt-view-options__heading">Columns</div>
          <ul className="nd-viewopts__list nt-view-options__list">
            {arranged.map((column, index) => {
              const isHidden = hidden.has(column.key);
              const locked = column.hideable === false;
              const lastVisible = !isHidden && visibleCount === 1;
              return (
                <li key={column.key} className="nd-viewopts__item nt-view-options__item">
                  <label className={cx('nd-checkbox', 'nd-viewopts__check', 'nt-view-options__check')}>
                    <input
                      type="checkbox"
                      checked={!isHidden}
                      disabled={locked || lastVisible}
                      title={locked ? 'the primary column always stays visible' : undefined}
                      onChange={() => toggle(column)}
                    />
                    <span>{column.title}</span>
                  </label>
                  <span className="nd-viewopts__moves nt-view-options__moves">
                    <button
                      type="button"
                      className="nd-viewopts__move nt-view-options__move"
                      aria-label={`Move ${column.title} earlier`}
                      disabled={index === 0}
                      onClick={() => move(column, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="nd-viewopts__move nt-view-options__move"
                      aria-label={`Move ${column.title} later`}
                      disabled={index === arranged.length - 1}
                      onClick={() => move(column, 1)}
                    >
                      ↓
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {isDefault ? null : (
            <button type="button" className="nd-viewopts__reset nt-view-options__reset" onClick={() => onChange({})}>
              Reset to defaults
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
