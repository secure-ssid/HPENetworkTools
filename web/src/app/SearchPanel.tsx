/**
 * web/src/app/SearchPanel.tsx — global search field + results panel.
 *
 * Port of the shell prototype's search behaviour: ⌘K/Ctrl+K focuses the field
 * and opens the panel; Escape closes; typing filters the flat search index
 * (kind/label/meta); an empty query shows the first 6 entries; Enter opens the
 * first hit; clicking a row opens it; clicking anywhere outside closes.
 * Navigation is uniform by `view` + `arg` — see pathForSearchHit in ./nav.ts.
 *
 * NightDesk 2.0: glass “cinema” panel, kind gutter, copper active rule.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input, Kbd } from '../nightdesk';
import { SEARCH_INDEX } from '@hpe/shared';
import type { InventoryTreeNode, SearchIndexEntry } from '@hpe/shared';
import { getSearchIndex, searchInventory } from '../api/client';
import { pathForSearchHit } from './nav';

type SearchResult = SearchIndexEntry & { path?: string };

export function SearchPanel() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [index, setIndex] = useState<SearchIndexEntry[]>(SEARCH_INDEX);
  const [inventoryResults, setInventoryResults] = useState<InventoryTreeNode[]>([]);
  /* Linked planes the server could not search. Kept apart from the results so
   * an empty panel can say WHY it is empty rather than implying a clean miss. */
  const [unsearched, setUnsearched] = useState<string[]>([]);
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

  /* Query edits that drop below the searchable length retire the remote
   * results immediately, here in the event path — clearing them from the
   * effect below would be a synchronous setState in an effect body. */
  const applyQuery = (value: string) => {
    setQuery(value);
    if (value.trim().length < 2) {
      setInventoryResults([]);
      setUnsearched([]);
    }
  };

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchInventory(q, { limit: 20, signal: controller.signal })
        .then((page) => {
          setInventoryResults(page.nodes);
          setUnsearched(page.unsearchedPlanes ?? []);
        })
        .catch((cause) => {
          if ((cause as Error).name !== 'AbortError') {
            setInventoryResults([]);
            // The search itself failed, so nothing was searched. Clearing the
            // list without clearing this would attribute the whole miss to
            // the named planes.
            setUnsearched([]);
          }
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

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
  const localMatches: SearchResult[] = q
    ? index.filter((r) => (r.label + ' ' + r.meta + ' ' + r.kind).toLowerCase().includes(q))
    : index.slice(0, 6);
  const remoteMatches: SearchResult[] = inventoryResults
    .filter((node) => node.target)
    .map((node) => ({
      kind: node.kind,
      label: node.label,
      meta: node.meta ?? node.status,
      view: 'inventory',
      arg: null,
      path: node.target,
    }));
  const resultKey = (result: SearchResult) =>
    `${result.kind === 'switch' ? 'device' : result.kind}:${result.label.trim().toLowerCase()}`;
  const matches = [...remoteMatches, ...localMatches]
    .filter(
      (result, index, rows) =>
        rows.findIndex((candidate) => resultKey(candidate) === resultKey(result)) === index,
    )
    .slice(0, 30);

  const openHit = (r: SearchResult) => {
    setOpen(false);
    applyQuery('');
    navigate(r.path ?? pathForSearchHit(r));
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
    <div className="nt-global-search" ref={rootRef}>
      <Input
        mono
        className="nt-global-search__field"
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
        onChange={(e) => {
          applyQuery(e.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onFocus={() => {
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="nt-global-search__hotkeys" aria-hidden="true">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </div>
      {open ? (
        <div id={listboxId} role="listbox" className="nt-global-search__panel">
          <div className="nt-global-search__hint">
            <span>Jump · estate cinema</span>
            <span>↑↓ enter · esc</span>
          </div>
          {matches.map((r, i) => (
            <button
              key={`${r.kind}-${r.label}-${i}`}
              id={`${listboxId}-option-${i}`}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              className={`nt-global-search__hit${i === activeIndex ? ' nt-global-search__hit--active' : ''}`}
              onClick={() => openHit(r)}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="nt-global-search__kind">{r.kind}</span>
              <span className="nt-global-search__label">{r.label}</span>
              <span className="nt-global-search__meta">{r.meta}</span>
            </button>
          ))}
          {matches.length === 0 ? (
            <div className="nt-global-search__empty">
              {unsearched.length > 0
                ? `Nothing matched in the planes that answered. ${unsearched.join(', ')} could not be searched.`
                : 'Nothing matches that. Try a hostname, MAC prefix or site.'}
            </div>
          ) : null}
          {/* Shown alongside results too: a hit in one plane says nothing
              about what an unread plane would have matched. */}
          {unsearched.length > 0 && matches.length > 0 ? (
            <div className="nt-global-search__warn">
              {`Not searched: ${unsearched.join(', ')} — these results are incomplete.`}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
