/**
 * web/src/nightdesk/DataTable.tsx — a column-definition table carrying the
 * nightdesk table superpowers. The plain compound `Table` stays for simple
 * tables; a screen moves to DataTable when it wants any of:
 *
 *   · a managed column set — show/hide, reorder and edge-drag resize, driven
 *     by a CONTROLLED `columnsConfig` prop the screen persists (Devices wires
 *     it through SettingsContext). Pair with <TableViewOptions/> for the
 *     'View options' dropdown UI; resize lives on the header edge.
 *   · keyboard-first rows — pass `onRowActivate` (and optionally the
 *     controlled `selectedKeys`/`onSelectionChange` pair) and the table
 *     becomes an ARIA grid with a roving tabindex (one tab stop): j/↓ and
 *     k/↑ move the focused row, Enter/→ runs the row's primary action, x
 *     toggles the row's selection, Esc clears the selection and then row
 *     focus. Selection is exposed only through those props so the
 *     change-queue bulk-actions work can consume it later.
 *   · threshold-tint cells — a column may carry `tint(row) → Tone | null`;
 *     the cell gets a ~12%-alpha tone wash (`nd-table__td--tint-<tone>`).
 *     Mechanics only: WHICH columns may tint is a per-screen decision, and
 *     Devices deliberately tints nothing.
 *
 * A column is declared once, as data:
 *
 *   const columns: DataTableColumn<DeviceRow>[] = [
 *     { key: 'device', title: 'Device', hideable: false, render: (d) => … },
 *     { key: 'clients', title: 'Clients', numeric: true, width: 120,
 *       tint: (d) => (d.clients > 40 ? 'warning' : null), render: (d) => … },
 *   ];
 *
 * The config is keyed by the stable column `key`, never the label, and is
 * tolerant of drift between a persisted copy and the code: keys the code no
 * longer defines are ignored, columns added since the save append at the
 * end, and a config that would hide every column is treated as corrupt and
 * shows all of them instead.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Tone } from '@hpe/shared';
import { cx } from './utils';

/** Paint only a window once tables grow past this many rows. */
const VIRTUALIZE_AFTER = 80;
const VIRTUAL_OVERSCAN = 8;

/* ---------- column definitions & config ---------- */

export type DataTableColumn<Row> = {
  /** Stable id. The column manager persists against this key, never the label. */
  key: string;
  /** Plain-text column name, used by the View options list (header may be rich). */
  title: string;
  /** Header cell content; defaults to `title`. */
  header?: ReactNode;
  /** Body cell content. */
  render: (row: Row, index: number) => ReactNode;
  /** Right-aligned mono numerals, same rule as Table.Cell's numeric flag. */
  numeric?: boolean;
  /** Width in px before any user resize. Absent = auto. */
  width?: number;
  /** Resize floor in px (default 56). */
  minWidth?: number;
  /** false = the column always stays visible and is not offered for hiding
   *  (the row's primary identifier). Default true. */
  hideable?: boolean;
  /** Threshold tint MECHANICS: return a tone to wash the cell background at
   *  ~12% alpha, null/undefined for no tint. */
  tint?: (row: Row) => Tone | null | undefined;
  /** Sortable value. Its presence makes the header clickable, cycling
   *  ascending → descending → off; null/undefined sorts last in BOTH
   *  directions (a missing value is never a smallest one). */
  sortValue?: (row: Row) => string | number | null | undefined;
};

/** The controlled, per-table column-manager state a screen persists. */
export type TableColumnsConfig = {
  /** Column keys in display order. Absent = definition order. */
  order?: string[];
  /** Hidden column keys. */
  hidden?: string[];
  /** User-set widths in px, by column key. */
  widths?: Record<string, number>;
};

const DEFAULT_MIN_WIDTH = 56;
/** Drag start width when neither layout nor config can provide one (jsdom). */
const FALLBACK_START_WIDTH = 120;

/**
 * Every column in effective display order: config order first (keys the code
 * still defines), then columns added since the config was saved, in
 * definition order. Unknown keys are dropped. Hidden columns are INCLUDED —
 * this is the order the View options list shows.
 */
export function arrangeColumns<Row>(
  columns: Array<DataTableColumn<Row>>,
  config?: TableColumnsConfig,
): Array<DataTableColumn<Row>> {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const seen = new Set<string>();
  const arranged: Array<DataTableColumn<Row>> = [];
  for (const key of config?.order ?? []) {
    const column = byKey.get(key);
    if (column && !seen.has(key)) {
      arranged.push(column);
      seen.add(key);
    }
  }
  for (const column of columns) {
    if (!seen.has(column.key)) {
      arranged.push(column);
      seen.add(column.key);
    }
  }
  return arranged;
}

/**
 * The columns the table actually renders: arranged order minus the hidden
 * set. Non-hideable columns are never filtered out, and a config that would
 * hide EVERY column falls back to showing all of them — a zero-column table
 * has no honest rendering, so the preference is corrupt, not honoured.
 */
export function visibleColumns<Row>(
  columns: Array<DataTableColumn<Row>>,
  config?: TableColumnsConfig,
): Array<DataTableColumn<Row>> {
  const arranged = arrangeColumns(columns, config);
  const hidden = new Set(config?.hidden ?? []);
  const visible = arranged.filter((column) => !hidden.has(column.key) || column.hideable === false);
  return visible.length > 0 ? visible : arranged;
}

/** Effective column width: the user's resize wins over the column default. */
export function columnWidth<Row>(column: DataTableColumn<Row>, config?: TableColumnsConfig): number | undefined {
  return config?.widths?.[column.key] ?? column.width;
}

/* ---------- sorting ---------- */

export type SortDirection = 'asc' | 'desc';
export type DataTableSort = { key: string; dir: SortDirection } | null;

/** One comparison: numbers numerically, strings locale-aware with numeric
 *  runs ('ch 6' < 'ch 116'), null/undefined last in both directions. */
export function compareSortValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  dir: SortDirection,
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const cmp =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? cmp : -cmp;
}

/* ---------- the table ---------- */

type DataTableProps<Row> = {
  columns: Array<DataTableColumn<Row>>;
  rows: Row[];
  /** Stable row identity — drives row keys, the roving tabindex and selection. */
  rowKey: (row: Row) => string;
  density?: 'comfortable' | 'compact';
  className?: string;
  /** Accessible name for the table/grid. */
  ariaLabel: string;
  /** Controlled column config. Pair with onColumnsConfigChange; without that
   *  callback the config is honoured but cannot change (no resize handles). */
  columnsConfig?: TableColumnsConfig;
  onColumnsConfigChange?: (config: TableColumnsConfig) => void;
  /** The focused row's primary action: Enter/→, or a click outside any
   *  nested control. Passing it opts the table into keyboard-grid mode. */
  onRowActivate?: (row: Row) => void;
  /** Controlled selection (row keys). Pair with onSelectionChange. */
  selectedKeys?: ReadonlyArray<string>;
  onSelectionChange?: (keys: string[]) => void;
};

/** Clicks and keys inside a nested control belong to that control, not the row. */
function isInsideControl(target: HTMLElement): boolean {
  return target.closest('button, a, input, select, textarea, label, [role="switch"]') !== null;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  density = 'comfortable',
  className,
  ariaLabel,
  columnsConfig,
  onColumnsConfigChange,
  onRowActivate,
  selectedKeys,
  onSelectionChange,
}: DataTableProps<Row>) {
  const visible = useMemo(() => visibleColumns(columns, columnsConfig), [columns, columnsConfig]);
  const keyboard = onRowActivate !== undefined || onSelectionChange !== undefined;
  const selectable = selectedKeys !== undefined && onSelectionChange !== undefined;
  const selected = useMemo(() => new Set(selectedKeys ?? []), [selectedKeys]);
  const rowHeight = density === 'compact' ? 32 : 40;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);

  // Roving tabindex: the key of the row holding the table's one tab stop.
  // State records where the user put it; the render falls back to the first
  // row whenever that row leaves the current set (a filter change).
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  // Header-click sorting: asc → desc → off, uncontrolled per mount.
  const [sort, setSort] = useState<DataTableSort>(null);
  const cycleSort = (column: DataTableColumn<Row>) => {
    if (!column.sortValue) return;
    setSort((cur) =>
      cur?.key !== column.key ? { key: column.key, dir: 'asc' } : cur.dir === 'asc' ? { key: column.key, dir: 'desc' } : null,
    );
  };
  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    const get = column.sortValue;
    const dir = sort.dir;
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => compareSortValues(get(a.row), get(b.row), dir) || a.index - b.index)
      .map((entry) => entry.row);
  }, [rows, sort, columns]);

  const keys = useMemo(() => sortedRows.map(rowKey), [sortedRows, rowKey]);
  const effectiveActiveKey =
    activeKey !== null && keys.includes(activeKey) ? activeKey : (keys[0] ?? null);

  const virtualized = sortedRows.length > VIRTUALIZE_AFTER;
  const virtualWindow = useMemo(() => {
    if (!virtualized) {
      return { start: 0, end: sortedRows.length, top: 0, bottom: 0 };
    }
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - VIRTUAL_OVERSCAN);
    const visibleCount = Math.ceil(viewportH / rowHeight) + VIRTUAL_OVERSCAN * 2;
    const end = Math.min(sortedRows.length, start + visibleCount);
    return {
      start,
      end,
      top: start * rowHeight,
      bottom: Math.max(0, (sortedRows.length - end) * rowHeight),
    };
  }, [virtualized, scrollTop, viewportH, rowHeight, sortedRows.length]);

  useEffect(() => {
    if (!virtualized) return;
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => setViewportH(el.clientHeight || 480)) : null;
    setViewportH(el.clientHeight || 480);
    el.addEventListener('scroll', onScroll, { passive: true });
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [virtualized]);

  useEffect(() => {
    if (!virtualized || effectiveActiveKey === null) return;
    const idx = keys.indexOf(effectiveActiveKey);
    if (idx < 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const top = idx * rowHeight;
    const bottom = top + rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [effectiveActiveKey, virtualized, keys, rowHeight]);

  const toggleSelected = (key: string) => {
    if (!selectable) return;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(Array.from(next));
  };

  const onTableKeyDown = (event: ReactKeyboardEvent<HTMLTableElement>) => {
    if (!keyboard) return;
    const target = event.target as HTMLElement;
    const rowEl = target.closest('tr[data-row-key]');
    if (!rowEl || target !== rowEl) return; // a nested control owns its keys
    const key = rowEl.getAttribute('data-row-key');
    const index = key === null ? -1 : keys.indexOf(key);
    if (index < 0) return;
    const moveFocus = (nextIndex: number) => {
      const nextKey = keys[Math.max(0, Math.min(nextIndex, keys.length - 1))];
      if (nextKey === undefined) return;
      setActiveKey(nextKey);
      rowRefs.current.get(nextKey)?.focus();
    };
    switch (event.key) {
      case 'j':
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(index + 1);
        break;
      case 'k':
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(index - 1);
        break;
      case 'Enter':
      case 'ArrowRight':
        if (onRowActivate) {
          event.preventDefault();
          onRowActivate(sortedRows[index] as Row);
        }
        break;
      case 'x':
        if (selectable) {
          event.preventDefault();
          toggleSelected(key as string);
        }
        break;
      case 'Escape':
        // Clears in layers: a live selection first, row focus second.
        if (selectable && selected.size > 0) {
          event.preventDefault();
          onSelectionChange([]);
        } else {
          rowRefs.current.get(key as string)?.blur();
        }
        break;
      default:
        break;
    }
  };

  /* Edge-drag resize. Listeners live on the document so the drag survives
     leaving the header; widths stream through the controlled config, so the
     screen's persistence decides when to write (SettingsContext debounces
     the network half). jsdom has no layout, so a zero measured width falls
     back to the column's configured width and then to a constant — the drag
     delta is what matters. */
  const startResize = (event: ReactPointerEvent, column: DataTableColumn<Row>) => {
    if (!onColumnsConfigChange) return;
    event.preventDefault();
    event.stopPropagation();
    const th = (event.target as HTMLElement).closest('th');
    const startX = event.clientX;
    const startWidth =
      th?.getBoundingClientRect().width || columnWidth(column, columnsConfig) || FALLBACK_START_WIDTH;
    const minWidth = column.minWidth ?? DEFAULT_MIN_WIDTH;
    const onMove = (move: PointerEvent) => {
      const width = Math.max(minWidth, Math.round(startWidth + move.clientX - startX));
      onColumnsConfigChange({
        ...columnsConfig,
        widths: { ...columnsConfig?.widths, [column.key]: width },
      });
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const paintedRows = virtualized ? sortedRows.slice(virtualWindow.start, virtualWindow.end) : sortedRows;
  const colSpan = Math.max(1, visible.length);

  return (
    <div ref={scrollRef} className={cx('nd-table-scroll', virtualized && 'nd-table-scroll--virtual')}>
      <table
        className={cx('nd-table', 'nd-table--open', density === 'compact' && 'nd-table--compact', className)}
        role={keyboard ? 'grid' : undefined}
        aria-label={ariaLabel}
        aria-rowcount={keyboard ? rows.length + 1 : undefined}
        aria-colcount={keyboard ? visible.length : undefined}
        onKeyDown={keyboard ? onTableKeyDown : undefined}
      >
        <colgroup>
          {visible.map((column) => {
            const width = columnWidth(column, columnsConfig);
            return <col key={column.key} style={width !== undefined ? { width } : undefined} />;
          })}
        </colgroup>
        <thead>
          <tr role={keyboard ? 'row' : undefined}>
            {visible.map((column) => {
              const sortable = column.sortValue !== undefined;
              const isSorted = sort?.key === column.key;
              return (
                <th
                  key={column.key}
                  role={keyboard ? 'columnheader' : undefined}
                  data-column-key={column.key}
                  aria-sort={isSorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cx('nd-table__th', column.numeric && 'nd-table__th--numeric')}
                >
                  {sortable ? (
                    <button type="button" className="nd-table__sort" onClick={() => cycleSort(column)}>
                      {column.header ?? column.title}
                      <span className={cx('nd-table__sort-mark', isSorted && 'nd-table__sort-mark--active')} aria-hidden="true">
                        {isSorted ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    (column.header ?? column.title)
                  )}
                  {onColumnsConfigChange ? (
                    <span
                      className="nd-table__resize"
                      aria-hidden="true"
                      onPointerDown={(event) => startResize(event, column)}
                    />
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {virtualized && virtualWindow.top > 0 ? (
            <tr aria-hidden="true" className="nd-table__tr--spacer">
              <td colSpan={colSpan} style={{ height: virtualWindow.top, padding: 0, border: 0 }} />
            </tr>
          ) : null}
          {paintedRows.map((row, paintedIndex) => {
            const index = virtualized ? virtualWindow.start + paintedIndex : paintedIndex;
            const key = keys[index] as string;
            return (
              <tr
                key={key}
                ref={(el) => {
                  if (el) rowRefs.current.set(key, el);
                  else rowRefs.current.delete(key);
                }}
                role={keyboard ? 'row' : undefined}
                aria-rowindex={keyboard ? index + 2 : undefined}
                aria-selected={selectable ? selected.has(key) : undefined}
                data-row-key={keyboard ? key : undefined}
                className={cx(
                  onRowActivate && 'nd-table__tr--interactive',
                  selectable && selected.has(key) && 'nd-table__tr--selected',
                )}
                tabIndex={keyboard ? (key === effectiveActiveKey ? 0 : -1) : undefined}
                onFocus={keyboard ? () => setActiveKey(key) : undefined}
                onClick={
                  onRowActivate
                    ? (event) => {
                        if (isInsideControl(event.target as HTMLElement)) return;
                        onRowActivate(row);
                      }
                    : undefined
                }
              >
                {visible.map((column) => {
                  const tone = column.tint?.(row);
                  return (
                    <td
                      key={column.key}
                      role={keyboard ? 'gridcell' : undefined}
                      className={cx(
                        'nd-table__td',
                        column.numeric && 'nd-table__td--numeric',
                        tone && `nd-table__td--tint-${tone}`,
                      )}
                    >
                      {column.render(row, index)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {virtualized && virtualWindow.bottom > 0 ? (
            <tr aria-hidden="true" className="nd-table__tr--spacer">
              <td colSpan={colSpan} style={{ height: virtualWindow.bottom, padding: 0, border: 0 }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
