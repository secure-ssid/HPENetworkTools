/**
 * web/src/app/SearchPanel.tsx — global search field + results panel.
 *
 * Port of the shell prototype's search behaviour: ⌘K/Ctrl+K focuses the field
 * and opens the panel; Escape closes; typing filters the flat search index
 * (kind/label/meta); an empty query shows the first 6 entries; Enter opens the
 * first hit; clicking a row opens it; clicking anywhere outside closes.
 * Navigation is uniform by `view` + `arg` — see pathForSearchHit in ./nav.ts.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input, Kbd } from '../nightdesk';
import { SEARCH_INDEX } from '../../../shared';
import type { SearchIndexEntry } from '../../../shared';
import { getSearchIndex } from '../api/client';
import { pathForSearchHit } from './nav';

export function SearchPanel() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [index, setIndex] = useState<SearchIndexEntry[]>(SEARCH_INDEX);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  // nightdesk Input does not forward refs — reach the field through the wrapper.
  const focusInput = () => rootRef.current?.querySelector('input')?.focus();

  useEffect(() => {
    let live = true;
    void getSearchIndex().then((d) => {
      if (live) setIndex(d.entries);
    });
    return () => {
      live = false;
    };
  }, []);

  // ⌘K / Ctrl+K opens and focuses; Escape closes (also while field unfocused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
        focusInput();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Clicking anywhere outside the field/panel (e.g. the content area) closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const q = query.trim().toLowerCase();
  const matches = q
    ? index.filter((r) => (r.label + ' ' + r.meta + ' ' + r.kind).toLowerCase().includes(q))
    : index.slice(0, 6);

  const openHit = (r: SearchIndexEntry) => {
    setOpen(false);
    setQuery('');
    navigate(pathForSearchHit(r));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') setOpen(false);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.min(current + 1, Math.max(0, matches.length - 1)));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.max(0, current - 1));
    }
    if (e.key === 'Enter' && matches[activeIndex]) openHit(matches[activeIndex]);
  };

  return (
    <div
      className="nt-global-search"
      ref={rootRef}
      style={{ marginLeft: 'auto', position: 'relative', width: 'min(420px, 100%)' }}
    >
      <Input
        mono
        value={query}
        placeholder="Jump to a site, device, MAC, IP or ticket…"
        aria-label="Global search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && matches[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined
        }
        style={{ paddingRight: 74 }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onFocus={() => {
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div
        id={listboxId}
        role="listbox"
        style={{
          position: 'absolute',
          right: 8,
          top: 7,
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </div>
      {open ? (
        <div
          style={{
            position: 'absolute',
            top: 38,
            left: 0,
            right: 0,
            background: 'var(--nd-bg-raised)',
            border: '1px solid var(--nd-border-default)',
            borderRadius: 'var(--nd-radius-md)',
            boxShadow: 'var(--nd-shadow-overlay)',
            padding: 6,
            maxHeight: 340,
            overflow: 'auto',
            zIndex: 30,
          }}
        >
          {matches.map((r, i) => (
            <button
              key={`${r.kind}-${r.label}-${i}`}
              id={`${listboxId}-option-${i}`}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              onClick={() => openHit(r)}
              onMouseEnter={() => setActiveIndex(i)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: i === activeIndex ? 'var(--nd-bg-surface)' : 'none',
                border: 'none',
                textAlign: 'left',
                padding: '7px 8px',
                borderRadius: 'var(--nd-radius-sm)',
                cursor: 'pointer',
                color: 'var(--nd-text-primary)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-10)',
                  letterSpacing: '.1em',
                  color: 'var(--nd-text-muted)',
                  width: 52,
                  flex: '0 0 52px',
                  textTransform: 'uppercase',
                }}
              >
                {r.kind}
              </span>
              <span
                style={{
                  fontSize: 13,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.label}
              </span>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: 'var(--nd-text-muted)',
                }}
              >
                {r.meta}
              </span>
            </button>
          ))}
          {matches.length === 0 ? (
            <div
              style={{
                padding: '10px 8px',
                fontSize: 'var(--nd-text-12)',
                color: 'var(--nd-text-muted)',
                fontFamily: 'var(--nd-font-display)',
                fontStyle: 'italic',
              }}
            >
              Nothing matches that. Try a hostname, MAC prefix or site.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
