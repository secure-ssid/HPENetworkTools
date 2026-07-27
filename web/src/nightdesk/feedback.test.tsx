import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Alert, ToastProvider, useToast } from './feedback';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Alert', () => {
  it('defaults to the info tone and announces itself', () => {
    render(<Alert title="Heads up">Two reconciliation gaps worth money</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toBe('nd-alert nd-alert--info');
    expect(screen.getByText('Heads up').className).toBe('nd-alert__title');
    expect(screen.getByText('Two reconciliation gaps worth money').className).toBe('nd-alert__body');
  });

  it.each([
    ['success', 'nd-alert--success'],
    ['warning', 'nd-alert--warning'],
    ['danger', 'nd-alert--danger'],
    ['info', 'nd-alert--info'],
    ['neutral', 'nd-alert--neutral'],
  ] as const)('maps tone %s onto %s', (tone, expected) => {
    render(<Alert tone={tone}>body</Alert>);
    expect(screen.getByRole('alert').className).toBe(`nd-alert ${expected}`);
  });

  it('omits the title and body wrappers when nothing was given for them', () => {
    const { container } = render(<Alert tone="neutral" title="Title only" />);
    expect(container.querySelector('.nd-alert__title')?.textContent).toBe('Title only');
    expect(container.querySelector('.nd-alert__body')).toBeNull();
  });

  it('offers no dismiss control unless it is dismissible', () => {
    render(<Alert>No console URL recorded for central</Alert>);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('removes itself and notifies the owner when dismissed', () => {
    const onDismiss = vi.fn();
    render(
      <Alert dismissible onDismiss={onDismiss} title="Sync is behind">
        body
      </Alert>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Sync is behind')).toBeNull();
  });
});

/** Exercises the hook the way every screen does. */
function ToastButton({
  label,
  title,
  description,
  tone,
}: {
  label: string;
  title: string;
  description?: string;
  tone?: 'success' | 'warning' | 'danger' | 'info' | 'accent';
}) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast(title, { description, tone })}>
      {label}
    </button>
  );
}

describe('ToastProvider / useToast', () => {
  it('refuses to work outside a provider rather than silently swallowing a toast', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ToastButton label="go" title="x" />)).toThrow(
      /useToast must be used within a ToastProvider/,
    );
    spy.mockRestore();
  });

  it('renders nothing until something is toasted, in a polite live region', () => {
    const { container } = render(
      <ToastProvider>
        <ToastButton label="Reboot" title="Reboot queued" />
      </ToastProvider>,
    );
    const region = container.querySelector('.nd-toast-region') as HTMLElement;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.children).toHaveLength(0);
  });

  it('renders the title, description and tone of a toast', () => {
    const { container } = render(
      <ToastProvider>
        <ToastButton
          label="Reboot"
          title="Reboot queued"
          description="ap-lake-01 · ticket CHG-1042"
          tone="warning"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reboot' }));

    const toastEl = container.querySelector('.nd-toast') as HTMLElement;
    expect(toastEl.className).toBe('nd-toast nd-toast--warning');
    expect(screen.getByText('Reboot queued').className).toBe('nd-toast__title');
    expect(screen.getByText('ap-lake-01 · ticket CHG-1042').className).toBe('nd-toast__desc');
  });

  it('leaves off the tone modifier and the description node when neither was given', () => {
    const { container } = render(
      <ToastProvider>
        <ToastButton label="Copy" title="Copied" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect((container.querySelector('.nd-toast') as HTMLElement).className).toBe('nd-toast');
    expect(container.querySelector('.nd-toast__desc')).toBeNull();
  });

  it('stacks concurrent toasts instead of replacing the previous one', () => {
    const { container } = render(
      <ToastProvider>
        <ToastButton label="A" title="First" />
        <ToastButton label="B" title="Second" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.click(screen.getByRole('button', { name: 'B' }));

    expect(container.querySelectorAll('.nd-toast')).toHaveLength(2);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('retires each toast on its own timer, oldest first', () => {
    vi.useFakeTimers();
    const { container } = render(
      <ToastProvider>
        <ToastButton label="A" title="First" />
        <ToastButton label="B" title="Second" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'B' }));

    // 4200ms after the first, only the first is gone.
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByText('Second')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Second')).toBeNull();
    expect(container.querySelectorAll('.nd-toast')).toHaveLength(0);
  });

  it('keeps a stable identity per toast so two identical titles do not collapse', () => {
    const { container } = render(
      <ToastProvider>
        <ToastButton label="A" title="Saved" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    expect(container.querySelectorAll('.nd-toast')).toHaveLength(2);
    expect(screen.getAllByText('Saved')).toHaveLength(2);
  });

  it('clears pending dismiss timers on unmount, so a toast raised before a navigation cannot fire against a torn-down tree', () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <ToastProvider>
        <ToastButton label="Push" title="Change pushed" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    expect(screen.getByText('Change pushed')).toBeTruthy();

    unmount();
    // Without the unmount cleanup the 4.2s dismiss timer survives and fires a
    // setState against an unmounted provider. Advancing well past it must be
    // inert.
    expect(vi.getTimerCount()).toBe(0);
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
    }).not.toThrow();
  });
});
