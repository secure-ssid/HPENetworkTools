import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

const DRAWER_WIDTHS = { md: 440, lg: 560 } as const;

export function Drawer({
  open,
  onOpenChange,
  width = 'md',
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width?: 'md' | 'lg' | number;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = drawerRef.current;
    const focusable = () =>
      Array.from(
        drawer?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
      if (e.key === 'Tab') {
        const items = focusable();
        if (items.length === 0) {
          e.preventDefault();
          drawer?.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.requestAnimationFrame(() => {
      (focusable()[0] ?? drawer)?.focus();
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previousFocus?.focus();
    };
  }, [open, onOpenChange]);

  if (!open) return null;
  const w = typeof width === 'number' ? width : DRAWER_WIDTHS[width];

  return createPortal(
    <div className="nd-drawer-root">
      <div className="nd-drawer-overlay" onClick={() => onOpenChange(false)} />
      <div
        ref={drawerRef}
        className="nd-drawer"
        style={{ width: w }}
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : 'Dialog'}
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="nd-drawer__header">
          <div>
            {title ? <div id={titleId} className="nd-drawer__title">{title}</div> : null}
            {description ? <div id={descriptionId} className="nd-drawer__description">{description}</div> : null}
          </div>
          <button
            type="button"
            className="nd-drawer__close"
            aria-label="Close dialog"
            onClick={() => onOpenChange(false)}
          >
            ×
          </button>
        </div>
        <div className="nd-drawer__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
