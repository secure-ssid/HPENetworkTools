import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TableViewOptions } from './TableViewOptions';
import type { DataTableColumn, TableColumnsConfig } from './DataTable';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Row = { name: string };

const COLUMNS: Array<DataTableColumn<Row>> = [
  { key: 'device', title: 'Device', hideable: false, render: (r) => r.name },
  { key: 'model', title: 'Model', render: () => 'm' },
  { key: 'clients', title: 'Clients', render: () => 'c' },
];

function renderOptions(config: TableColumnsConfig = {}, onChange = vi.fn()) {
  const utils = render(<TableViewOptions columns={COLUMNS} config={config} onChange={onChange} />);
  return { onChange, ...utils };
}

describe('TableViewOptions', () => {
  it('opens on the trigger and lists every column in effective order', () => {
    renderOptions({ order: ['clients', 'device', 'model'] });
    expect(screen.queryByText('Columns')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    const items = screen.getAllByRole('checkbox').map((box) => box.closest('label')?.textContent);
    expect(items).toEqual(['Clients', 'Device', 'Model']);
  });

  it('hides a column by unchecking it, and shows it again by rechecking', () => {
    const { onChange } = renderOptions();
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Model' }));
    expect(onChange).toHaveBeenLastCalledWith({ hidden: ['model'] });
  });

  it('checks a hidden column back into view without resurrecting stale keys', () => {
    const { onChange } = renderOptions({ hidden: ['model', 'gone-column'] });
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    const model = screen.getByRole('checkbox', { name: 'Model' }) as HTMLInputElement;
    expect(model.checked).toBe(false);
    fireEvent.click(model);
    // 'gone-column' is not a column any more, so it does not survive the write.
    expect(onChange).toHaveBeenLastCalledWith({ hidden: [] });
  });

  it('never offers to hide the primary column or the last visible one', () => {
    renderOptions({ hidden: ['clients'] });
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    // The primary column is locked; Model still shares the table with it, so
    // Model itself may hide — the last-visible guard only fires when a table
    // would otherwise drop to zero columns.
    expect((screen.getByRole('checkbox', { name: 'Device' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Model' }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Clients' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('locks the checkbox of the last visible column', () => {
    const allHideable: Array<DataTableColumn<Row>> = [
      { key: 'a', title: 'Alpha', render: (r) => r.name },
      { key: 'b', title: 'Beta', render: () => 'b' },
    ];
    render(<TableViewOptions columns={allHideable} config={{ hidden: ['b'] }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect((screen.getByRole('checkbox', { name: 'Alpha' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Beta' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('moves a column with the arrow buttons, writing the full order', () => {
    const { onChange } = renderOptions();
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Device later' }));
    expect(onChange).toHaveBeenLastCalledWith({ order: ['model', 'device', 'clients'] });
  });

  it('disables the move buttons at the ends of the list', () => {
    renderOptions();
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect((screen.getByRole('button', { name: 'Move Device earlier' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move Clients later' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers a reset only away from defaults, and resets to the empty config', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TableViewOptions columns={COLUMNS} config={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull();

    rerender(<TableViewOptions columns={COLUMNS} config={{ hidden: ['model'] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('closes on Escape and on a pointer down outside', () => {
    renderOptions();
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect(screen.queryByText('Columns')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Columns')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect(screen.queryByText('Columns')).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText('Columns')).toBeNull();
  });
});
