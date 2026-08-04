/**
 * Overlay primitives — Modal/Confirm, Tooltip, Tabs, Menu.
 * Keeps focus traps and chrome in one place so screens stop hand-rolling popovers.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './utils';
import { Button } from './forms';

/* ---------- Modal / Confirm ---------- */

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 440,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
}) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const root = panelRef.current;
    const focusable = root?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return createPortal(
    <div className="nd-modal-root nt-modal-root" role="presentation">
      <button
        type="button"
        className="nd-modal__scrim nt-modal__scrim"
        aria-label="Close dialog"
        onClick={() => onOpenChange(false)}
      />
      <div
        ref={panelRef}
        className={cx('nd-modal', 'nt-modal-panel', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        style={{ ['--nd-overlay-w' as string]: typeof width === 'number' ? `${width}px` : width }}
      >
        <div className="nd-modal__header nt-modal__header">
          <div>
            <div id={titleId} className="nd-modal__title nt-modal__title">
              {title}
            </div>
            {description ? (
              <div id={descId} className="nd-modal__desc nt-modal__desc">
                {description}
              </div>
            ) : null}
          </div>
          <button type="button" className="nd-modal__close nt-modal__close" onClick={() => onOpenChange(false)} aria-label="Close">
            ×
          </button>
        </div>
        {children ? <div className="nd-modal__body nt-modal__body">{children}</div> : null}
        {footer ? <div className="nd-modal__footer nt-modal__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'accent' | 'neutral';
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      className="nd-modal--write-ritual nd-modal--confirm nt-write-ritual nt-modal-panel"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            size="sm"
            disabled={busy}
            onClick={() => {
              void Promise.resolve(onConfirm()).then(() => onOpenChange(false));
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="nt-write-ritual nt-write-ritual--banner" aria-hidden />
    </Modal>
  );
}

/* ---------- Tooltip ---------- */

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="nd-tooltip nt-tooltip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      {open ? (
        <span role="tooltip" id={id} className={cx('nd-tooltip__bubble', `nd-tooltip__bubble--${side}`, 'nt-tooltip__bubble')}>
          {content}
        </span>
      ) : null}
    </span>
  );
}

/* ---------- Tabs ---------- */

type TabsCtx = {
  value: string;
  setValue: (v: string) => void;
  idBase: string;
};

const TabsContext = createContext<TabsCtx | null>(null);

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  children,
  className,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const idBase = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? '');
  const current = value ?? uncontrolled;
  const setValue = useCallback(
    (v: string) => {
      if (value === undefined) setUncontrolled(v);
      onValueChange?.(v);
    },
    [value, onValueChange],
  );
  const ctx = useMemo(() => ({ value: current, setValue, idBase }), [current, setValue, idBase]);
  return (
    <TabsContext.Provider value={ctx}>
      <div className={cx('nd-tabs', 'nt-tabs', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ children, className, 'aria-label': ariaLabel }: { children: ReactNode; className?: string; 'aria-label'?: string }) {
  return (
    <div className={cx('nd-tabs__list', className)} role="tablist" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('TabsTrigger requires Tabs');
  const selected = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.idBase}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${ctx.idBase}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      className={cx('nd-tabs__trigger', 'nd-tabs__tab', 'nt-tabs__trigger', selected && 'nd-tabs__trigger--active', selected && 'nt-tabs__trigger--active')}
      data-active={selected ? 'true' : 'false'}
      onClick={() => ctx.setValue(value)}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('TabsContent requires Tabs');
  if (ctx.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${ctx.idBase}-panel-${value}`}
      aria-labelledby={`${ctx.idBase}-tab-${value}`}
      className={cx('nd-tabs__content', className)}
    >
      {children}
    </div>
  );
}

/* ---------- Menu ---------- */

export function Menu({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'end',
  width = 220,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  width?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className="nd-menu nt-menu">
      <div
        className="nd-menu__trigger nt-menu__trigger"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenChange(!open);
          }
        }}
      >
        {trigger}
      </div>
      {open ? (
        <div
          role="menu"
          className={cx('nd-menu__panel', 'nd-menu', 'nt-menu__panel', 'nt-panel-glass', align === 'start' ? 'nd-menu__panel--start' : 'nd-menu__panel--end')}
          style={{ ['--nd-overlay-w' as string]: typeof width === 'number' ? `${width}px` : `${width}` } satisfies CSSProperties}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cx('nd-menu__item', 'nt-menu__item', danger && 'nd-menu__item--danger')}
      disabled={disabled}
      onClick={() => onSelect?.()}
    >
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="nd-menu__sep nt-menu__sep" role="separator" />;
}

/* ---------- Popover anchor helper for measured tooltips ---------- */

export function useFloatingOpen(initial = false) {
  const [open, setOpen] = useState(initial);
  useLayoutEffect(() => {
    if (!open) return;
  }, [open]);
  return [open, setOpen] as const;
}
