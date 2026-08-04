/**
 * ActionOverflow — collapses a row of secondary panel actions (copy link,
 * export CSV, download server CSV) into a single "…" button in the corner.
 *
 * Every panel repeated the same three links in full, which cost a whole
 * header row per section and buried the one or two actions that differ.
 * The actions themselves are unchanged — they are just folded behind a
 * disclosure until asked for.
 *
 * Native <details>/<summary> is used deliberately: it gives keyboard and
 * screen-reader behaviour for free, and it still works if JS for outside
 * click handling never runs.
 */
import { useEffect, useRef } from 'react';

export function ActionOverflow({
  children,
  label = 'Panel actions',
}: {
  children: React.ReactNode;
  /** Accessible name; say what the actions act on when a page has several. */
  label?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const close = (event: MouseEvent) => {
      if (!el.open) return;
      if (event.target instanceof Node && el.contains(event.target)) return;
      el.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && el.open) {
        el.open = false;
        el.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  return (
    <details className="nt-action-overflow" ref={ref}>
      <summary
        className="nt-action-overflow__trigger"
        aria-label={label}
        title={label}
      >
        <span aria-hidden>···</span>
      </summary>
      {/* Clicking an action should dismiss the menu the same way a real
          menu does; the actions keep their own onClick handlers. */}
      <div
        className="nt-action-overflow__menu"
        onClick={() => {
          if (ref.current) ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
