import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Drawer } from './Drawer';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = '';
});

/** Default drawer contents: one focusable control below the close button. */
const BODY = <button type="button">Save</button>;

/** Mirrors how a screen drives the drawer: a trigger outside, state above. */
function Host({
  startOpen = false,
  title = 'Connect Aruba Central',
  description,
  children,
}: {
  startOpen?: boolean;
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Add plane
      </button>
      <Drawer open={open} onOpenChange={setOpen} title={title} description={description}>
        {children ?? BODY}
      </Drawer>
    </>
  );
}

const closeBtn = () => screen.getByRole('button', { name: 'Close dialog' });

describe('Drawer open / closed', () => {
  it('renders nothing at all while closed — no hidden dialog in the tree', () => {
    render(<Host />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.querySelector('.nd-drawer-root')).toBeNull();
  });

  it('portals the dialog to document.body rather than nesting it in the caller', () => {
    const { container } = render(<Host startOpen />);
    expect(container.querySelector('.nd-drawer')).toBeNull();
    expect(document.body.querySelector('.nd-drawer')).not.toBeNull();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('opens from a trigger and closes again from the close button', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Add plane' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(closeBtn());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on an overlay click', async () => {
    render(<Host startOpen />);
    fireEvent.click(document.body.querySelector('.nd-drawer-overlay') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on Escape', async () => {
    render(<Host startOpen />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stops listening for Escape once closed', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Drawer open onOpenChange={onOpenChange} title="T">
        {BODY}
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledTimes(1);

    rerender(
      <Drawer open={false} onOpenChange={onOpenChange} title="T">
        {BODY}
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });
});

describe('Drawer labelling', () => {
  it('labels the dialog by its own title node when it has one', () => {
    render(<Host startOpen title="Connect Aruba Central" />);
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toBe('Connect Aruba Central');
    expect(dialog.hasAttribute('aria-label')).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Connect Aruba Central' })).toBeTruthy();
  });

  it('falls back to a generic accessible name when no title is given', () => {
    render(
      <Drawer open onOpenChange={() => {}}>
        {BODY}
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Dialog');
    expect(dialog.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('describes the dialog only when a description is supplied', () => {
    const { rerender } = render(<Host startOpen description="API gateway credentials" />);
    const describedBy = screen.getByRole('dialog').getAttribute('aria-describedby');
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'API gateway credentials',
    );

    rerender(<Host startOpen />);
    expect(screen.getByRole('dialog').hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('Drawer width', () => {
  it.each([
    ['md', '440px'],
    ['lg', '560px'],
  ] as const)('resolves the %s preset to %s', (width, expected) => {
    render(
      <Drawer open onOpenChange={() => {}} width={width} title="T">
        {BODY}
      </Drawer>,
    );
    expect((screen.getByRole('dialog') as HTMLElement).style.width).toBe(expected);
  });

  describe('Drawer side', () => {
    it('can open from the left for navigation drawers', () => {
      render(
        <Drawer open onOpenChange={() => {}} side="left" title="Navigation">
          {BODY}
        </Drawer>,
      );
      expect(screen.getByRole('dialog').classList.contains('nd-drawer--left')).toBe(true);
    });
  });

  it('accepts an explicit pixel width', () => {
    render(
      <Drawer open onOpenChange={() => {}} width={720} title="T">
        {BODY}
      </Drawer>,
    );
    expect((screen.getByRole('dialog') as HTMLElement).style.width).toBe('720px');
  });
});

describe('Drawer scroll lock', () => {
  it('locks the page behind the drawer and restores the previous value on close', async () => {
    document.body.style.overflow = 'auto';
    const { rerender } = render(
      <Drawer open onOpenChange={() => {}} title="T">
        {BODY}
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <Drawer open={false} onOpenChange={() => {}} title="T">
        {BODY}
      </Drawer>,
    );
    await waitFor(() => expect(document.body.style.overflow).toBe('auto'));
  });

  it('restores the page scroll even if the drawer unmounts while still open', async () => {
    document.body.style.overflow = 'auto';
    const { unmount } = render(
      <Drawer open onOpenChange={() => {}} title="T">
        {BODY}
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    await waitFor(() => expect(document.body.style.overflow).toBe('auto'));
  });
});

describe('Drawer focus management', () => {
  it('moves focus inside the drawer when it opens', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Add plane' }));
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('returns focus to the control that opened it', async () => {
    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'Add plane' });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));

    fireEvent.click(closeBtn());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('traps Tab at the end of the drawer and wraps to the first control', async () => {
    render(
      <Host startOpen>
        <>
          <button type="button">Test connection</button>
          <button type="button">Save</button>
        </>
      </Host>,
    );
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));

    const last = screen.getByRole('button', { name: 'Save' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn());
  });

  it('traps Shift+Tab at the start of the drawer and wraps to the last control', async () => {
    render(
      <Host startOpen>
        <>
          <button type="button">Test connection</button>
          <button type="button">Save</button>
        </>
      </Host>,
    );
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('leaves Tab alone in the middle of the drawer so the browser can move focus', async () => {
    render(
      <Host startOpen>
        <>
          <button type="button">Test connection</button>
          <button type="button">Save</button>
        </>
      </Host>,
    );
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));

    const middle = screen.getByRole('button', { name: 'Test connection' });
    middle.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    // Not first and not last: the trap must not hijack it.
    expect(document.activeElement).toBe(middle);
  });

  it('skips disabled controls when deciding where the trap boundaries are', async () => {
    render(
      <Host startOpen>
        <>
          <button type="button">Test connection</button>
          <button type="button" disabled>
            Save
          </button>
        </>
      </Host>,
    );
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));

    // 'Save' is disabled, so 'Test connection' is the last reachable control.
    screen.getByRole('button', { name: 'Test connection' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn());
  });

  /**
   * REGRESSION GUARD. The focus effect used to depend on [open, onOpenChange].
   * Screens pass an inline lambda (Configure.tsx:1050, Clients.tsx:649,
   * Systems.tsx:1373), giving it a fresh identity on every render, so every
   * keystroke in a controlled field tore the effect down and re-ran it —
   * re-focusing focusable()[0], the close button. The SSID form in Configure
   * lost focus after one character. Drawer.tsx now holds the callback in a ref
   * and depends on [open] alone; this test fails again if that regresses.
   */
  it('keeps focus in the field the operator is typing in', async () => {
    function Typing() {
      const [open, setOpen] = useState(true);
      const [value, setValue] = useState('');
      return (
        <Drawer open={open} onOpenChange={(o) => setOpen(o)} title="Edit SSID">
          <input aria-label="SSID name" value={value} onChange={(e) => setValue(e.target.value)} />
        </Drawer>
      );
    }
    render(<Typing />);
    await waitFor(() => expect(document.activeElement).toBe(closeBtn()));

    const field = screen.getByLabelText('SSID name') as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: 'c' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.activeElement).toBe(field);
  });
});
