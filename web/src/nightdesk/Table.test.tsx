import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Table } from './Table';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Row = { name: string; clients: string };

function renderTable(rows: Row[], opts: { onOpen?: (name: string) => void; compact?: boolean } = {}) {
  return render(
    <Table density={opts.compact ? 'compact' : 'comfortable'}>
      <Table.Head>
        <Table.Row>
          <Table.HeaderCell>Device</Table.HeaderCell>
          <Table.HeaderCell numeric>Clients</Table.HeaderCell>
        </Table.Row>
      </Table.Head>
      <Table.Body>
        {rows.length === 0 ? (
          <Table.Row>
            <Table.Cell colSpan={2}>No devices reported by this plane</Table.Cell>
          </Table.Row>
        ) : (
          rows.map((r) => (
            <Table.Row
              key={r.name}
              interactive={!!opts.onOpen}
              onClick={opts.onOpen ? () => opts.onOpen?.(r.name) : undefined}
            >
              <Table.Cell>{r.name}</Table.Cell>
              <Table.Cell numeric>{r.clients}</Table.Cell>
            </Table.Row>
          ))
        )}
      </Table.Body>
    </Table>,
  );
}

const ROWS: Row[] = [
  { name: 'ap-lake-01', clients: '18' },
  { name: 'sw-lake-core', clients: '—' },
];

describe('Table shell', () => {
  it('wraps the table in its own scroll container so a wide table never scrolls the page', () => {
    const { container } = renderTable(ROWS);
    const scroll = container.querySelector('.nd-table-scroll');
    expect(scroll).not.toBeNull();
    expect(scroll?.firstElementChild?.tagName).toBe('TABLE');
  });

  it('defaults to comfortable density and adds the compact class only when asked', () => {
    const { container, rerender } = renderTable(ROWS);
    const table = () => container.querySelector('table') as HTMLTableElement;
    expect(table().className).toBe('nd-table nd-table--open');

    rerender(<Table density="compact" className="mine"><tbody /></Table>);
    expect(table().className.split(' ')).toEqual([
      'nd-table',
      'nd-table--open',
      'nd-table--compact',
      'mine',
    ]);
  });
});

describe('Table rows vs empty state', () => {
  it('renders one body row per record', () => {
    const { container } = renderTable(ROWS);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.getByText('ap-lake-01')).toBeTruthy();
    expect(screen.queryByText('No devices reported by this plane')).toBeNull();
  });

  it('renders a single named empty row spanning the header when there are no records', () => {
    const { container } = renderTable([]);
    const bodyRows = container.querySelectorAll('tbody tr');
    expect(bodyRows).toHaveLength(1);
    const cell = bodyRows[0].querySelector('td') as HTMLTableCellElement;
    // An honest named empty state, spanning the full header width.
    expect(cell.textContent).toBe('No devices reported by this plane');
    expect(cell.getAttribute('colspan')).toBe('2');
  });
});

describe('Table cells', () => {
  it('flags numeric header and body cells so they right-align as a column', () => {
    const { container } = renderTable(ROWS);
    const ths = Array.from(container.querySelectorAll('th'));
    expect(ths[0].className).toBe('nd-table__th');
    expect(ths[1].className).toBe('nd-table__th nd-table__th--numeric');

    const tds = Array.from(container.querySelectorAll('tbody td'));
    expect(tds[0].className).toBe('nd-table__td');
    expect(tds[1].className).toBe('nd-table__td nd-table__td--numeric');
  });

  it('appends caller classNames to cells', () => {
    const { container } = render(
      <Table>
        <Table.Body>
          <Table.Row>
            <Table.Cell className="wide">x</Table.Cell>
          </Table.Row>
        </Table.Body>
      </Table>,
    );
    expect((container.querySelector('td') as HTMLElement).className).toContain('wide');
  });
});

describe('Table.Row interaction', () => {
  it('is not focusable and carries no interactive class when it does nothing', () => {
    const { container } = renderTable(ROWS);
    const row = container.querySelector('tbody tr') as HTMLTableRowElement;
    expect(row.className).toBe('');
    expect(row.hasAttribute('tabindex')).toBe(false);
  });

  it('marks itself interactive and reachable by keyboard when it has an onClick', () => {
    const onOpen = vi.fn();
    const { container } = renderTable(ROWS, { onOpen });
    const row = container.querySelector('tbody tr') as HTMLTableRowElement;
    expect(row.className).toContain('nd-table__tr--interactive');
    expect(row.getAttribute('tabindex')).toBe('0');
  });

  it('opens on click', () => {
    const onOpen = vi.fn();
    renderTable(ROWS, { onOpen });
    fireEvent.click(screen.getByText('ap-lake-01'));
    expect(onOpen).toHaveBeenCalledWith('ap-lake-01');
  });

  it.each(['Enter', ' '] as const)('opens on %s so the row is not mouse-only', (key) => {
    const onOpen = vi.fn();
    const { container } = renderTable(ROWS, { onOpen });
    fireEvent.keyDown(container.querySelector('tbody tr') as HTMLElement, { key });
    expect(onOpen).toHaveBeenCalledWith('ap-lake-01');
  });

  it('ignores other keys so arrow/tab navigation still works', () => {
    const onOpen = vi.fn();
    const { container } = renderTable(ROWS, { onOpen });
    const row = container.querySelector('tbody tr') as HTMLElement;
    fireEvent.keyDown(row, { key: 'ArrowDown' });
    fireEvent.keyDown(row, { key: 'Tab' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('takes the interactive class from the interactive prop alone, without becoming focusable', () => {
    // A row styled as interactive but with no handler must not advertise a
    // keyboard affordance it cannot honour.
    const { container } = render(
      <Table>
        <Table.Body>
          <Table.Row interactive>
            <Table.Cell>x</Table.Cell>
          </Table.Row>
        </Table.Body>
      </Table>,
    );
    const row = container.querySelector('tbody tr') as HTMLTableRowElement;
    expect(row.className).toContain('nd-table__tr--interactive');
    expect(row.hasAttribute('tabindex')).toBe(false);
  });
});
