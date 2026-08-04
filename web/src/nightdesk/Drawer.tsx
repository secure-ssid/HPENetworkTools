import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

const DRAWER_WIDTHS = { md: 440, lg: 560 } as const;

export function Drawer({
  open,
  onOpenChange,
  width = 'md',
  side = 'right',
  title,
  description,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width?: 'md' | 'lg' | number;
  side?: 'left' | 'right';
  title?: ReactNode;
  description?: ReactNode;
  /** Extra classes on the panel (e.g. write-ritual chrome). */
  className?: string;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Held in a ref so the focus/keydown effect below does not depend on the
  // callback's identity. Screens pass an inline lambda (Configure, Clients,
  // Systems), which is a fresh function every render — depending on it tore the
  // effect down on each keystroke and re-focused the close button, so a
  // controlled field inside a drawer lost focus after one character.
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });

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
      if (e.key === 'Escape') onOpenChangeRef.current(false);
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
  }, [open]);

  if (!open) return null;
  const w = typeof width === 'number' ? width : DRAWER_WIDTHS[width];

  return createPortal(
    <div className="nd-drawer-root nt-drawer-root">
      <div className="nd-drawer-overlay nt-drawer-overlay" onClick={() => onOpenChange(false)} />
      <div
        ref={drawerRef}
        className={['nd-drawer', 'nd-drawer__panel', 'nt-drawer', 'nt-drawer__panel', `nd-drawer--${side}`, className].filter(Boolean).join(' ')}
        style={{ ['--nd-overlay-w' as string]: typeof w === 'number' ? `${w}px` : w }}
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : 'Dialog'}
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="nd-drawer__header nt-drawer__header">
          <div>
            <div className="nt-drawer-kicker" aria-hidden>NightDesk · drawer</div>
            {title ? <div id={titleId} className="nd-drawer__title nt-drawer__title">{title}</div> : null}
            {description ? <div id={descriptionId} className="nd-drawer__description nt-drawer__description">{description}</div> : null}
          </div>
          <button
            type="button"
            className="nd-drawer__close nt-drawer__close"
            aria-label="Close dialog"
            onClick={() => onOpenChange(false)}
          >
            ×
          </button>
        </div>
        <div className="nd-drawer__body nt-drawer__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
