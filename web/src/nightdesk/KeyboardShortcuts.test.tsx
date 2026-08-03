import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DATATABLE_ROW_SHORTCUTS, KeyboardShortcuts } from './KeyboardShortcuts';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('KeyboardShortcuts', () => {
  it('opens from its button and lists the declared entries', () => {
    render(<KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Keyboard shortcuts')).toBeTruthy();
    expect(screen.getByText('Move to the next row')).toBeTruthy();
    expect(screen.getByText('j / ↓')).toBeTruthy();
    expect(screen.getByText('x')).toBeTruthy();
  });

  it("opens on the '?' key and toggles closed on a second one", () => {
    render(<KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />);
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("ignores a '?' typed into an editable field — that is text, not a help request", () => {
    render(
      <div>
        <input aria-label="Filter" />
        <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
      </div>,
    );
    fireEvent.keyDown(screen.getByLabelText('Filter'), { key: '?' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("ignores a '?' with a modifier held — a browser binding, not ours", () => {
    render(<KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />);
    fireEvent.keyDown(document.body, { key: '?', ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape, on the scrim, and on the close button', () => {
    render(<KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />);

    fireEvent.keyDown(document.body, { key: '?' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(document.body, { key: '?' });
    fireEvent.click(document.querySelector('.nd-shortcuts-overlay') as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(document.body, { key: '?' });
    fireEvent.click(screen.getByRole('button', { name: 'Close keyboard shortcuts' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves focus inside on open and returns it on close', async () => {
    render(
      <div>
        <button type="button">Before</button>
        <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
      </div>,
    );
    const before = screen.getByRole('button', { name: 'Before' });
    before.focus();
    fireEvent.keyDown(document.body, { key: '?' });
    // Focus moves on a requestAnimationFrame, so wait a turn.
    await vi.waitFor(() => {
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(before);
  });
});
