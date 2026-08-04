/**
 * web/src/app/SearchPanel.tsx — global search field + results panel.
 *
 * Port of the shell prototype's search behaviour: ⌘K/Ctrl+K focuses the field
 * and opens the panel; Escape closes; typing filters the flat search index
 * (kind/label/meta); an empty query shows the first 6 entries; Enter opens the
 * first hit; clicking a row opens it; clicking anywhere outside closes.
 * Optional kind Select narrows local index + inventory hits and rides
 * **Download server CSV** (`?kind=` matches GET /api/search-index/export).
 * A **Kind** chip row (counts over the current query universe — Loop 153)
 * toggles the same kind filter as the Select — click again to clear.
 * Quick actions (raise ticket / silence / diagnostic) rank above screen jumps
 * when kind=All. Navigation is uniform by `view` + `arg` — see pathForSearchHit.
 * Recent multi-select (Loop 189) raises **Export selected**, **Copy queries**,
 * and **Remove selected** beside the existing Clear-all control. Panel
 * `KeyboardShortcuts` surfaces the ⌘K / arrow / Enter / Esc map (Loop 202).
 *
 * NightDesk 2.0: glass “cinema” panel, kind gutter, copper active rule.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Kbd,
  KeyboardShortcuts,
  Select,
  useToast,
  type ShortcutEntry,
} from '../nightdesk';
import { SEARCH_INDEX, countOf } from '@hpe/shared';
import type { InventoryTreeNode, SearchIndexEntry } from '@hpe/shared';
import { getSearchIndex, searchInventory } from '../api/client';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { pathForSearchHit } from './nav';
import { matchQuickActions } from './quickActions';
import { matchScreenJumps } from './screenJumps';

type SearchResult = SearchIndexEntry & { path?: string };

export const RECENT_SEARCH_KEY = 'nt-global-search-recent';
const RECENT_SEARCH_MAX = 6;

/** ⌘K panel key map — not the DataTable row set. */
export const SEARCH_PANEL_SHORTCUTS: ShortcutEntry[] = [
  { keys: '⌘K / Ctrl+K', action: 'Open and focus global search' },
  { keys: '↑ / ↓', action: 'Move between results' },
  { keys: 'Enter', action: 'Open the focused result' },
  { keys: 'Esc', action: 'Close the search panel' },
  { keys: '?', action: 'Show or hide this overlay' },
];

/** Normalize inventory kinds (switch/ap/gateway) to the jump-index device bucket. */
export function searchKindKey(kind: string): string {
  const raw = String(kind).toLowerCase();
  if (
    raw === 'switch' ||
    raw === 'ap' ||
    raw === 'gateway' ||
    raw === 'device'
  ) {
    return 'device';
  }
  if (raw.includes('alert')) return 'alert';
  if (raw.includes('site')) return 'site';
  if (raw.includes('client')) return 'client';
  if (raw.includes('ticket')) return 'ticket';
  return raw;
}

export function matchesSearchKindFilter(kind: string, filter: string): boolean {
  if (!filter || filter === 'all') return true;
  const want = filter.trim().toLowerCase();
  const raw = String(kind).toLowerCase();
  if (raw === want) return true;
  /* device filter also keeps inventory switch/ap/gateway hits. */
  if (want === 'device') return searchKindKey(kind) === 'device';
  return false;
}

export function loadRecentSearches(): string[] {
  try {
    const raw = sessionStorage.getItem(RECENT_SEARCH_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim())
      .slice(0, RECENT_SEARCH_MAX);
  } catch {
    return [];
  }
}

export function pushRecentSearch(value: string): string[] {
  const q = value.trim();
  if (q.length < 2) return loadRecentSearches();
  const next = [q, ...loadRecentSearches().filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(
    0,
    RECENT_SEARCH_MAX,
  );
  try {
    sessionStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — recent is best-effort */
  }
  return next;
}

export function SearchPanel() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [index, setIndex] = useState<SearchIndexEntry[]>(SEARCH_INDEX);
  const [inventoryResults, setInventoryResults] = useState<InventoryTreeNode[]>([]);
  /* Linked planes the server could not search. Kept apart from the results so
   * an empty panel can say WHY it is empty rather than implying a clean miss. */
  const [unsearched, setUnsearched] = useState<string[]>([]);
  /* Estate search failure is not "nothing matches" — keep the message so a
   * broken inventory read never looks like a clean miss. */
  const [inventorySearchError, setInventorySearchError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => loadRecentSearches());
  /* Multi-select on recent queries (Loop 189 bulk export/copy/remove). */
  const [selectedRecent, setSelectedRecent] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  // nightdesk Input does not forward refs — reach the field through the wrapper.
  const focusInput = () => rootRef.current?.querySelector('input')?.focus();

  /* Drop bulk marks that left the recent list (Clear all / Remove selected). */
  const prunedRecent = selectedRecent.filter((q) => recent.includes(q));
  if (prunedRecent.length !== selectedRecent.length) setSelectedRecent(prunedRecent);

  const persistRecent = (next: string[]) => {
    try {
      if (next.length === 0) sessionStorage.removeItem(RECENT_SEARCH_KEY);
      else sessionStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
    } catch {
      /* private mode / quota — recent is best-effort */
    }
    setRecent(next);
  };

  const toggleRecentSelect = (value: string) => {
    setSelectedRecent((cur) =>
      cur.includes(value) ? cur.filter((k) => k !== value) : [...cur, value],
    );
  };

  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const entry of index) {
      const k = String(entry.kind ?? '').trim();
      if (k) set.add(k);
    }
    /* Keep device in the list even when the live index is empty so inventory
     * switch/ap hits stay filterable under the same bucket. */
    if (![...set].some((k) => searchKindKey(k) === 'device')) set.add('device');
    const sorted = [...set].sort((a, b) => a.localeCompare(b));
    return [{ value: 'all', label: 'All kinds' }, ...sorted.map((k) => ({ value: k, label: k }))];
  }, [index]);

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
      setInventorySearchError(null);
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
          setInventorySearchError(null);
        })
        .catch((cause) => {
          if ((cause as Error).name !== 'AbortError') {
            setInventoryResults([]);
            // The search itself failed, so nothing was searched. Clearing the
            // list without clearing this would attribute the whole miss to
            // the named planes.
            setUnsearched([]);
            setInventorySearchError((cause as Error).message || 'Inventory search failed');
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
  /* Quick actions + screen jumps sit above estate hits so "raise ticket" /
   * "silence" / "go licences" open the workflow immediately. Kind filter
   * "all" keeps them; a specific kind drops them (not devices/sites/…). */
  const actionMatchesAll: SearchResult[] = matchQuickActions(query);
  const screenMatchesAll: SearchResult[] = matchScreenJumps(query);
  const localMatchesAll: SearchResult[] = q
    ? index.filter((r) => (r.label + ' ' + r.meta + ' ' + r.kind).toLowerCase().includes(q))
    : index.slice(0, 6);
  const remoteMatchesAll: SearchResult[] = inventoryResults
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
    result.kind === 'action'
      ? `action:${result.path ?? pathForSearchHit(result)}`
      : result.kind === 'screen'
        ? `screen:${result.path ?? pathForSearchHit(result)}`
        : `${result.kind === 'switch' ? 'device' : result.kind}:${result.label.trim().toLowerCase()}`;
  /* Kind chips count over the query universe (not kind) so the mix stays
   * visible while a chip is active — Loop 153. */
  const kindUniverse = [
    ...actionMatchesAll,
    ...screenMatchesAll,
    ...remoteMatchesAll,
    ...localMatchesAll,
  ].filter(
    (result, i, rows) => rows.findIndex((c) => resultKey(c) === resultKey(result)) === i,
  );
  const kindChipKeys = [
    ...new Set(
      kindUniverse
        .map((r) => String(r.kind ?? '').trim())
        .filter((k) => k && k !== 'action' && k !== 'screen')
        .map((k) => (searchKindKey(k) === 'device' ? 'device' : k)),
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (kind !== 'all' && kind && !kindChipKeys.some((k) => k.toLowerCase() === kind.toLowerCase())) {
    kindChipKeys.unshift(kind);
  }
  const kindChips = kindChipKeys.map((key) => ({
    key,
    label: key,
    count: kindUniverse.filter((r) => matchesSearchKindFilter(String(r.kind), key)).length,
  }));
  const actionMatches: SearchResult[] =
    !kind || kind === 'all' ? actionMatchesAll : [];
  const screenMatches: SearchResult[] =
    !kind || kind === 'all' ? screenMatchesAll : [];
  const localMatches: SearchResult[] = localMatchesAll.filter((r) =>
    matchesSearchKindFilter(String(r.kind), kind),
  );
  const remoteMatches: SearchResult[] = remoteMatchesAll.filter((node) =>
    matchesSearchKindFilter(String(node.kind), kind),
  );
  const matches = [...actionMatches, ...screenMatches, ...remoteMatches, ...localMatches]
    .filter(
      (result, index, rows) =>
        rows.findIndex((candidate) => resultKey(candidate) === resultKey(result)) === index,
    )
    .slice(0, 30);

  const openHit = (r: SearchResult) => {
    /* Recent is best-effort — never block navigation if storage misbehaves. */
    try {
      if (query.trim().length >= 2) setRecent(pushRecentSearch(query));
    } catch {
      /* ignore */
    }
    setOpen(false);
    applyQuery('');
    navigate(r.path ?? pathForSearchHit(r));
  };

  const applyRecent = (value: string) => {
    applyQuery(value);
    setOpen(true);
    setActiveIndex(0);
    focusInput();
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
    <div className="nt-global-search nt-recon-reveal nt-cmdk-cinema" ref={rootRef}>
      <Input
        mono
        className="nt-global-search__field nt-cmdk-cinema__input"
        value={query}
        placeholder="Jump, raise ticket, silence, diagnostic…"
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
        <div className="nt-global-search__panel nt-panel-glass">
          <div className="nt-global-search__brand" aria-hidden>NightDesk · device cinema · ⌘K</div>
          <div className="nt-global-search__hint">
            <span>Jump · actions · screens · estate</span>
            <span className="nt-wrap-6">
              <Select
                options={kindOptions}
                value={kind}
                onValueChange={(v) => {
                  setKind(v);
                  setActiveIndex(0);
                  setOpen(true);
                }}
                size="sm"
                aria-label="Result kind"
              />
              {matches.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const n = exportTableCsv(
                      'search-hits.csv',
                      ['label', 'kind', 'meta', 'path'],
                      matches.map((r) => [
                        r.label,
                        r.kind,
                        r.meta ?? '',
                        r.path ?? pathForSearchHit(r),
                      ]),
                    );
                    toast(`Exported ${n} search hit${n === 1 ? '' : 's'}`, {
                      description: 'search-hits.csv — current panel results (no secrets).',
                    });
                  }}
                >
                  Export CSV
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void (async () => {
                    const qs = new URLSearchParams();
                    if (query.trim()) qs.set('q', query.trim());
                    if (kind !== 'all') qs.set('kind', kind);
                    const suffix = qs.toString() ? `?${qs.toString()}` : '';
                    const res = await downloadApiCsv(
                      `/api/search-index/export${suffix}`,
                      'search-index.csv',
                    );
                    if (res.ok) {
                      const bits: string[] = [];
                      if (query.trim()) bits.push(`q=${query.trim()}`);
                      if (kind !== 'all') bits.push(`kind=${kind}`);
                      toast('Server CSV downloaded', {
                        description: bits.length
                          ? `search-index.csv — portal jump index matching ${bits.join(' · ')}.`
                          : 'search-index.csv — full portal jump index (no secrets).',
                        tone: 'success',
                      });
                    } else {
                      toast('Server CSV failed', {
                        description: res.error ?? 'Could not download export',
                        tone: 'warning',
                      });
                    }
                  })();
                }}
              >
                Download server CSV
              </Button>
              <span className="nt-hint-muted" aria-hidden>
                ↑↓ enter · esc
              </span>
              {/* ⌘K panel has its own key map — surface it beside the legend (Loop 202). */}
              <KeyboardShortcuts entries={SEARCH_PANEL_SHORTCUTS} title="Search keyboard shortcuts" />
            </span>
          </div>
          {kindChips.length > 0 ? (
            <div className="nt-chip-row nt-chip-row--tight" role="group" aria-label="Search kind">
              <span className="nt-chip-row__label">Kind</span>
              {kindChips.map((c) => {
                const active = kind.toLowerCase() === c.key.toLowerCase();
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setKind(active ? 'all' : c.key);
                      setActiveIndex(0);
                      setOpen(true);
                    }}
                    className={active ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
                    aria-pressed={active}
                  >
                    <Badge tone="neutral">{c.label}</Badge>
                    <span className="nt-chip__count">{c.count}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {!q && recent.length > 0 ? (
            <div className="nt-global-search__recent" role="group" aria-label="Recent searches">
              <div className="nt-global-search__hint">
                <span>Recent</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    persistRecent([]);
                    setSelectedRecent([]);
                  }}
                >
                  Clear
                </Button>
              </div>
              {recent.map((r) => {
                const marked = selectedRecent.includes(r);
                return (
                  <div key={r} className="nt-global-search__recent-row">
                    <Checkbox
                      aria-label={`Select recent query ${r}`}
                      checked={marked}
                      onChange={() => toggleRecentSelect(r)}
                    />
                    <button
                      type="button"
                      className="nt-global-search__hit"
                      onClick={() => applyRecent(r)}
                    >
                      <span className="nt-global-search__kind" data-kind="recent">
                        recent
                      </span>
                      <span className="nt-global-search__label">{r}</span>
                      <span className="nt-global-search__meta">replay</span>
                    </button>
                  </div>
                );
              })}
              {selectedRecent.length > 0 ? (
                <div
                  className="nt-configure-bulk-bar nt-bulk-glass nt-global-search__recent-bulk"
                  role="region"
                  aria-label="Recent search selection actions"
                >
                  <span className="nt-configure-bulk-bar__count">{`${selectedRecent.length} SELECTED`}</span>
                  <span className="nt-configure-bulk-bar__hint">
                    export, copy, or remove only the recent queries you marked
                  </span>
                  <span className="nt-configure-bulk-bar__actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const picked = recent.filter((r) => selectedRecent.includes(r));
                        if (picked.length === 0) {
                          toast('No selected recent queries still listed', {
                            description: 'Clear selection or re-open the panel.',
                            tone: 'info',
                          });
                          return;
                        }
                        const n = exportTableCsv(
                          'search-recent-selected.csv',
                          ['query'],
                          picked.map((query) => [query]),
                        );
                        toast(`Exported ${countOf(n, 'recent query')}`, {
                          description: 'search-recent-selected.csv — query text only.',
                          tone: 'success',
                        });
                      }}
                    >
                      Export selected
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void (async () => {
                          const picked = recent.filter((r) => selectedRecent.includes(r));
                          if (picked.length === 0) {
                            toast('No selected recent queries still listed', {
                              description: 'Clear selection or re-open the panel.',
                              tone: 'info',
                            });
                            return;
                          }
                          const text = picked.join('\n');
                          try {
                            await navigator.clipboard.writeText(text);
                            toast(`Copied ${countOf(picked.length, 'query')}`, {
                              description: 'newline-joined · paste into notes or a ticket',
                              tone: 'success',
                            });
                          } catch {
                            toast('Could not copy queries', { description: text, tone: 'warning' });
                          }
                        })();
                      }}
                    >
                      Copy queries
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const drop = new Set(selectedRecent);
                        persistRecent(recent.filter((r) => !drop.has(r)));
                        setSelectedRecent([]);
                      }}
                    >
                      Remove selected
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedRecent([]);
                      }}
                    >
                      Clear
                    </Button>
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
          {/* listbox wraps only hit options — kind Select stays outside so native
              <option> nodes never pollute aria option queries. */}
          <div id={listboxId} role="listbox" aria-label="Search results">
            {matches.map((r, i) => {
              const kindKey = searchKindKey(String(r.kind));
              return (
              <button
                key={`${r.kind}-${r.label}-${i}`}
                id={`${listboxId}-option-${i}`}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                data-kind={kindKey}
                className={`nt-global-search__hit${i === activeIndex ? ' nt-global-search__hit--active' : ''}`}
                onClick={() => openHit(r)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="nt-global-search__kind" data-kind={kindKey}>{r.kind}</span>
                <span className="nt-global-search__label">{r.label}</span>
                <span className="nt-global-search__meta">{r.meta}</span>
              </button>
              );
            })}
            {matches.length === 0 ? (
              <div className="nt-global-search__empty" role="status">
                {inventorySearchError
                  ? `Inventory search unavailable — ${inventorySearchError}`
                  : unsearched.length > 0
                    ? `Nothing matched in the planes that answered. ${unsearched.join(', ')} could not be searched.`
                    : 'Nothing matches that. Try a hostname, MAC prefix or site.'}
              </div>
            ) : null}
          </div>
          {/* Shown alongside results too: a hit in one plane says nothing
              about what an unread plane would have matched. */}
          {unsearched.length > 0 && matches.length > 0 ? (
            <div className="nt-global-search__warn">
              {`Not searched: ${unsearched.join(', ')} — these results are incomplete.`}
            </div>
          ) : null}
          {inventorySearchError && matches.length > 0 ? (
            <div className="nt-global-search__warn" role="status">
              {`Inventory search unavailable — ${inventorySearchError}. Showing local index hits only.`}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
