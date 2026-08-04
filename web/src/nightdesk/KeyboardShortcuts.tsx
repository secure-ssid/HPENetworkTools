/**
 * web/src/nightdesk/KeyboardShortcuts.tsx — the '?' overlay. Renders the
 * small '?' button a screen places near a keyboard-driven surface, plus the
 * modal that button — or pressing '?' anywhere outside an editable field —
 * opens. Entries are declared by the screen, so the overlay always describes
 * the shortcuts that screen actually wired (DATATABLE_ROW_SHORTCUTS covers
 * the DataTable row-command set).
 *
 * The modal follows the Drawer's overlay rules: scrim click and Escape
 * close, focus moves inside on open and returns on close, Tab is trapped.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type ShortcutEntry = {
  /** The keys as the operator presses them — 'j / ↓', 'Enter / →', 'Esc'. */
  keys: string;
  /** What they do, in one clause. */
  action: string;
};

/** The DataTable row-command set, for screens that wire a keyboard grid. */
export const DATATABLE_ROW_SHORTCUTS: ShortcutEntry[] = [
  { keys: 'j / ↓', action: 'Move to the next row' },
  { keys: 'k / ↑', action: 'Move to the previous row' },
  { keys: 'Enter / →', action: "Run the focused row's primary action" },
  { keys: 'x', action: 'Toggle selection on the focused row' },
  { keys: 'Esc', action: 'Clear the selection, then row focus' },
  { keys: '?', action: 'Show or hide this overlay' },
];

/** A '?' typed into a field is text, not a help request. */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  );
}

export function KeyboardShortcuts({
  entries,
  title = 'Keyboard shortcuts',
}: {
  entries: ShortcutEntry[];
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // The global '?' listener. Modifiers disqualify (Ctrl+? is a browser
  // binding, not ours); the overlay toggles, so '?' also closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Focus + Escape + Tab trap, the same rules Drawer.tsx documents: the
  // callback identities are stable here, so the effect keys on `open` only.
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      if (event.key === 'Tab') {
        const items = focusable();
        if (items.length === 0) {
          event.preventDefault();
          panel?.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    window.requestAnimationFrame(() => {
      (focusable()[0] ?? panel)?.focus();
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      previousFocus?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="nd-shortcuts__trigger nt-hotkey-trigger"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        onClick={() => setOpen(true)}
      >
        ?
      </button>
      {open
        ? createPortal(
            <div className="nd-shortcuts-root nt-hotkey-root">
              <div className="nd-shortcuts-overlay nt-hotkey-scrim" onClick={() => setOpen(false)} />
              <div
                ref={panelRef}
                className="nd-shortcuts nt-hotkey-overlay nt-panel-glass"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
              >
                <div className="nd-shortcuts__header nt-hotkey-overlay__header">
                  <div className="nd-shortcuts__brand nt-hotkey-overlay__brand" aria-hidden>
                    HPE Network Tools · key map
                  </div>
                  <div id={titleId} className="nd-shortcuts__title nt-hotkey-overlay__title">
                    {title}
                  </div>
                  <button
                    type="button"
                    className="nd-shortcuts__close nt-hotkey-overlay__close"
                    aria-label="Close keyboard shortcuts"
                    onClick={() => setOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <ul className="nd-shortcuts__list nt-hotkey-overlay__list">
                  {entries.map((entry) => (
                    <li key={entry.keys} className="nd-shortcuts__item nt-hotkey-overlay__item">
                      <kbd className="nd-kbd nt-kbd">{entry.keys}</kbd>
                      <span>{entry.action}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
