import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type AlertTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function Alert({
  tone = 'info',
  title,
  dismissible,
  onDismiss,
  children,
}: {
  tone?: AlertTone;
  title?: string;
  dismissible?: boolean;
  onDismiss?: () => void;
  children?: ReactNode;
}) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const dismiss = () => {
    setHidden(true);
    onDismiss?.();
  };
  return (
    <div className={`nd-alert nd-alert--${tone} nt-callout-glass`} role="alert" data-tone={tone}>
      <div className="nd-alert__content nt-callout-glass__content">
        {title ? <div className="nd-alert__title nt-callout-glass__title">{title}</div> : null}
        {children ? <div className="nd-alert__body nt-callout-glass__body">{children}</div> : null}
      </div>
      {dismissible ? (
        <button type="button" className="nd-alert__dismiss nt-callout-glass__dismiss" onClick={dismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

/* ---------- toast ---------- */

type ToastTone = 'success' | 'warning' | 'danger' | 'info' | 'accent';

type ToastItem = {
  id: number;
  title: string;
  description?: string;
  tone?: ToastTone;
};

type ToastApi = {
  toast: (title: string, opts?: { description?: string; tone?: ToastTone }) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  // Every scheduled dismissal, so a toast raised just before the provider is
  // torn down (a navigation away, a test unmount) cannot fire setItems against
  // a dead tree 4.2s later.
  const timers = useRef(new Set<number>());

  const toast = useCallback<ToastApi['toast']>((title, opts) => {
    const id = ++nextId.current;
    setItems((xs) => [...xs, { id, title, description: opts?.description, tone: opts?.tone }]);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setItems((xs) => xs.filter((t) => t.id !== id));
    }, 4200);
    timers.current.add(timer);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="nd-toast-region nt-toast-region" role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`nd-toast nt-toast${t.tone ? ` nd-toast--${t.tone} nt-toast--${t.tone}` : ''}`} data-tone={t.tone || undefined}>
            <div className="nd-toast__title nt-toast__title">{t.title}</div>
            {t.description ? <div className="nd-toast__desc nt-toast__desc">{t.description}</div> : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
