import { createContext, useCallback, useContext, useRef, useState } from 'react';
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
    <div className={`nd-alert nd-alert--${tone}`} role="alert">
      <div className="nd-alert__content">
        {title ? <div className="nd-alert__title">{title}</div> : null}
        {children ? <div className="nd-alert__body">{children}</div> : null}
      </div>
      {dismissible ? (
        <button type="button" className="nd-alert__dismiss" onClick={dismiss}>
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

  const toast = useCallback<ToastApi['toast']>((title, opts) => {
    const id = ++nextId.current;
    setItems((xs) => [...xs, { id, title, description: opts?.description, tone: opts?.tone }]);
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="nd-toast-region" role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`nd-toast${t.tone ? ` nd-toast--${t.tone}` : ''}`}>
            <div className="nd-toast__title">{t.title}</div>
            {t.description ? <div className="nd-toast__desc">{t.description}</div> : null}
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
