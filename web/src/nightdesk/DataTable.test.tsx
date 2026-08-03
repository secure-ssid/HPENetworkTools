import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { DataTable, arrangeColumns, compareSortValues, visibleColumns } from './DataTable';
import type { DataTableColumn, TableColumnsConfig } from './DataTable';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Row = { name: string; model: string; clients: string };

const ROWS: Row[] = [
  { name: 'ap-lake-01', model: 'AP-635', clients: '18' },
  { name: 'sw-lake-core', model: 'CX 8325', clients: '—' },
];

function columns(opts: { tint?: boolean } = {}): Array<DataTableColumn<Row>> {
  return [
    { key: 'device', title: 'Device', hideable: false, render: (r) => r.name },
    { key: 'model', title: 'Model', width: 80, render: (r) => r.model },
    {
      key: 'clients',
      title: 'Clients',
      numeric: true,
      tint: opts.tint ? (r) => (r.name.startsWith('ap') ? 'warning' : null) : undefined,
      render: (r) => r.clients,
    },
  ];
}

function headerKeys(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('th')).map(
    (th) => th.getAttribute('data-column-key') ?? '',
  );
}

describe('DataTable columns', () => {
  it('renders every column in definition order when no config is given', () => {
    const { container } = render(<DataTable ariaLabel="Devices" columns={columns()} rows={ROWS} rowKey={(r) => r.name} />);
    expect(headerKeys(container)).toEqual(['device', 'model', 'clients']);
    expect(screen.getByText('AP-635')).toBeTruthy();
    // The header falls back to the plain title when no rich header is given.
    expect(screen.getByText('Model')).toBeTruthy();
  });

  it('applies the controlled config: order, hidden, and width', () => {
    const config: TableColumnsConfig = {
      order: ['clients', 'device', 'model'],
      hidden: ['model'],
      widths: { clients: 140 },
    };
    const { container } = render(
      <DataTable ariaLabel="Devices" columns={columns()} rows={ROWS} rowKey={(r) => r.name} columnsConfig={config} />,
    );
    expect(headerKeys(container)).toEqual(['clients', 'device']);
    const cols = Array.from(container.querySelectorAll('col'));
    expect(cols[0].style.width).toBe('140px');
    // A column default width applies where the config sets none — but the
    // hidden model column renders no col at all.
    expect(cols).toHaveLength(2);
  });

  it('uses the column default width when the config sets none', () => {
    const { container } = render(
      <DataTable ariaLabel="Devices" columns={columns()} rows={ROWS} rowKey={(r) => r.name} columnsConfig={{}} />,
    );
    const cols = Array.from(container.querySelectorAll('col'));
    expect(cols[1].style.width).toBe('80px');
    expect(cols[0].style.width).toBe('');
  });

  it('tolerates a stale config: unknown keys drop, new columns append, hide-all falls back to all', () => {
    const config: TableColumnsConfig = {
      order: ['ghost', 'clients'],
      hidden: ['also-gone'],
    };
    expect(arrangeColumns(columns(), config).map((c) => c.key)).toEqual(['clients', 'device', 'model']);

    // Hiding everything that MAY hide still leaves the non-hideable primary.
    const everythingHideable: TableColumnsConfig = { hidden: ['model', 'clients'] };
    expect(visibleColumns(columns(), everythingHideable).map((c) => c.key)).toEqual(['device']);

    // A config that would hide every column shows all of them instead.
    const allHideable: Array<DataTableColumn<Row>> = [
      { key: 'a', title: 'A', render: (r) => r.name },
      { key: 'b', title: 'B', render: (r) => r.model },
    ];
    expect(visibleColumns(allHideable, { hidden: ['a', 'b'] })).toHaveLength(2);

    // A non-hideable column ignores its own hidden entry.
    const primaryHidden: TableColumnsConfig = { hidden: ['device'] };
    expect(visibleColumns(columns(), primaryHidden).map((c) => c.key)).toEqual(['device', 'model', 'clients']);
  });

  it('washes a tinted cell in its tone and leaves the others plain', () => {
    const { container } = render(
      <DataTable ariaLabel="Devices" columns={columns({ tint: true })} rows={ROWS} rowKey={(r) => r.name} />,
    );
    const firstRowCells = container.querySelectorAll('tbody tr')[0].querySelectorAll('td');
    expect(firstRowCells[2].className).toContain('nd-table__td--tint-warning');
    expect(firstRowCells[0].className).not.toContain('tint');
    const secondRowCells = container.querySelectorAll('tbody tr')[1].querySelectorAll('td');
    expect(secondRowCells[2].className).not.toContain('tint');
  });
});

describe('DataTable resize', () => {
  it('drags a header edge to a new width through the controlled config', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DataTable
        ariaLabel="Devices"
        columns={columns()}
        rows={ROWS}
        rowKey={(r) => r.name}
        columnsConfig={{}}
        onColumnsConfigChange={onChange}
      />,
    );
    const handle = container.querySelector('th[data-column-key="model"] .nd-table__resize') as HTMLElement;
    expect(handle).not.toBeNull();
    // jsdom has no layout: the drag starts from the column's 80px default,
    // so a 40px rightward drag lands at 120.
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(document, { clientX: 140 });
    fireEvent.pointerUp(document);
    expect(onChange).toHaveBeenLastCalledWith({ widths: { model: 120 } });
  });

  it('clamps the drag at the column minimum and keeps earlier widths', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DataTable
        ariaLabel="Devices"
        columns={columns()}
        rows={ROWS}
        rowKey={(r) => r.name}
        columnsConfig={{ widths: { clients: 140 } }}
        onColumnsConfigChange={onChange}
      />,
    );
    const handle = container.querySelector('th[data-column-key="model"] .nd-table__resize') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(document, { clientX: 0 });
    fireEvent.pointerUp(document);
    expect(onChange).toHaveBeenLastCalledWith({ widths: { clients: 140, model: 56 } });
  });

  it('shows no resize handles without the change callback', () => {
    const { container } = render(
      <DataTable ariaLabel="Devices" columns={columns()} rows={ROWS} rowKey={(r) => r.name} columnsConfig={{ hidden: ['model'] }} />,
    );
    expect(container.querySelector('.nd-table__resize')).toBeNull();
  });
});

describe('DataTable keyboard grid', () => {
  function Grid(props: {
    onActivate?: (row: Row) => void;
    withSelection?: boolean;
    onSelectionChange?: (keys: string[]) => void;
  }) {
    const [selected, setSelected] = useState<string[]>([]);
    return (
      <DataTable
        ariaLabel="Devices"
        columns={columns()}
        rows={ROWS}
        rowKey={(r) => r.name}
        onRowActivate={props.onActivate}
        selectedKeys={props.withSelection ? selected : undefined}
        onSelectionChange={
          props.withSelection
            ? (keys) => {
                setSelected(keys);
                props.onSelectionChange?.(keys);
              }
            : undefined
        }
      />
    );
  }

  function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
    return Array.from(container.querySelectorAll('tbody tr'));
  }

  it('is a plain table — no grid roles, no tab stops — without keyboard props', () => {
    const { container } = render(<DataTable ariaLabel="Devices" columns={columns()} rows={ROWS} rowKey={(r) => r.name} />);
    expect(container.querySelector('table')?.getAttribute('role')).toBeNull();
    expect(bodyRows(container)[0].hasAttribute('tabindex')).toBe(false);
  });

  it('carries grid semantics: roles, row/col counts and row indices', () => {
    const { container } = render(<Grid onActivate={() => undefined} />);
    const table = container.querySelector('table') as HTMLTableElement;
    expect(table.getAttribute('role')).toBe('grid');
    expect(table.getAttribute('aria-label')).toBe('Devices');
    expect(table.getAttribute('aria-rowcount')).toBe('3'); // header included
    expect(table.getAttribute('aria-colcount')).toBe('3');
    expect(container.querySelector('th')?.getAttribute('role')).toBe('columnheader');
    expect(container.querySelector('td')?.getAttribute('role')).toBe('gridcell');
    expect(bodyRows(container)[0].getAttribute('aria-rowindex')).toBe('2');
  });

  it('roves a single tab stop and moves it with j/k and the arrow keys', () => {
    const { container } = render(<Grid onActivate={() => undefined} />);
    const [first, second] = bodyRows(container);
    expect(first.getAttribute('tabindex')).toBe('0');
    expect(second.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(first, { key: 'j' });
    expect(first.getAttribute('tabindex')).toBe('-1');
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: 'ArrowDown' }); // already last: stays
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: 'k' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'ArrowUp' }); // already first: stays
    expect(document.activeElement).toBe(first);
  });

  it('runs the primary action on Enter and on ArrowRight', () => {
    const onActivate = vi.fn();
    const { container } = render(<Grid onActivate={onActivate} />);
    const [first, second] = bodyRows(container);
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledWith(ROWS[0]);
    fireEvent.keyDown(second, { key: 'ArrowRight' });
    expect(onActivate).toHaveBeenCalledWith(ROWS[1]);
  });

  it('toggles selection with x, marks the row, and clears with Escape', () => {
    const onSelectionChange = vi.fn();
    const { container } = render(<Grid onActivate={() => undefined} withSelection onSelectionChange={onSelectionChange} />);
    const [first] = bodyRows(container);

    fireEvent.keyDown(first, { key: 'x' });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['ap-lake-01']);
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(first.className).toContain('nd-table__tr--selected');

    fireEvent.keyDown(first, { key: 'x' });
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(first.getAttribute('aria-selected')).toBe('false');

    // Select again, then Escape clears the selection (first Esc layer).
    fireEvent.keyDown(first, { key: 'x' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(first.getAttribute('aria-selected')).toBe('false');
  });

  it('releases row focus on Escape when there is no selection to clear', () => {
    const { container } = render(<Grid onActivate={() => undefined} />);
    const [first] = bodyRows(container);
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(document.activeElement).not.toBe(first);
  });

  it('ignores row commands typed inside a nested control', () => {
    const onActivate = vi.fn();
    const controlColumns: Array<DataTableColumn<Row>> = [
      { key: 'device', title: 'Device', render: () => <input aria-label="Rename" defaultValue="ap" /> },
    ];
    render(
      <DataTable
        ariaLabel="Devices"
        columns={controlColumns}
        rows={ROWS}
        rowKey={(r) => r.name}
        onRowActivate={onActivate}
      />,
    );
    const input = screen.getAllByLabelText('Rename')[0];
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'j' });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('activates on a row click but not on a click into a nested control', () => {
    const onActivate = vi.fn();
    const onButton = vi.fn();
    const clickable: Array<DataTableColumn<Row>> = [
      {
        key: 'device',
        title: 'Device',
        render: (r) => (
          <button type="button" onClick={onButton}>
            {r.name}
          </button>
        ),
      },
      { key: 'model', title: 'Model', render: (r) => r.model },
    ];
    render(
      <DataTable ariaLabel="Devices" columns={clickable} rows={ROWS} rowKey={(r) => r.name} onRowActivate={onActivate} />,
    );
    fireEvent.click(screen.getByText('AP-635'));
    expect(onActivate).toHaveBeenCalledWith(ROWS[0]);

    fireEvent.click(screen.getByText('ap-lake-01'));
    expect(onButton).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1); // the button click did not re-activate
  });
});


describe('DataTable sorting', () => {
  type SortRow = { name: string; count: number | null; since: string | null };
  const sortRows: SortRow[] = [
    { name: 'zeta', count: 3, since: '2h 14m' },
    { name: 'alpha', count: 19, since: null },
    { name: 'mid', count: null, since: '41d' },
  ];
  const sortCols: Array<DataTableColumn<SortRow>> = [
    { key: 'name', title: 'Name', sortValue: (r) => r.name, render: (r) => r.name },
    { key: 'count', title: 'Count', numeric: true, sortValue: (r) => r.count, render: (r) => r.count ?? '—' },
    { key: 'since', title: 'Since', sortValue: (r) => r.since, render: (r) => r.since ?? '—' },
  ];
  const names = () => screen.getAllByRole('row').slice(1).map((tr) => tr.textContent ?? '');

  it('cycles asc → desc → off on header clicks, marking aria-sort only while active', () => {
    render(<DataTable ariaLabel="Sortable" columns={sortCols} rows={sortRows} rowKey={(r) => r.name} />);
    const sortButton = screen.getByRole('button', { name: /Name/ });
    const th = sortButton.closest('th')!;

    expect(th.getAttribute('aria-sort')).toBeNull();
    fireEvent.click(sortButton);
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    expect(names()[0]).toContain('alpha');
    fireEvent.click(sortButton);
    expect(th.getAttribute('aria-sort')).toBe('descending');
    expect(names()[0]).toContain('zeta');
    fireEvent.click(sortButton);
    expect(th.getAttribute('aria-sort')).toBeNull(); // off — original order back
    expect(names()[0]).toContain('zeta');
  });

  it('sorts numbers numerically with nulls last in BOTH directions', () => {
    render(<DataTable ariaLabel="Sortable" columns={sortCols} rows={sortRows} rowKey={(r) => r.name} />);
    const sortButton = screen.getByRole('button', { name: /Count/ });
    fireEvent.click(sortButton); // asc: 3, 19, null
    expect(names()[0]).toContain('zeta');
    expect(names()[2]).toContain('mid');
    fireEvent.click(sortButton); // desc: 19, 3, null — null still last
    expect(names()[0]).toContain('alpha');
    expect(names()[2]).toContain('mid');
  });

  it('compares values: numeric runs inside strings, nulls always last', () => {
    expect(compareSortValues('ch 6', 'ch 116', 'asc')).toBeLessThan(0);
    expect(compareSortValues(19, 3, 'asc')).toBeGreaterThan(0);
    expect(compareSortValues(null, 'anything', 'asc')).toBeGreaterThan(0);
    expect(compareSortValues(null, 'anything', 'desc')).toBeGreaterThan(0); // still last
    expect(compareSortValues(null, null, 'asc')).toBe(0);
  });
});
