import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { InventoryTreeNode, SseObjectKind } from '@hpe/shared';
import { countOf } from '@hpe/shared';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  EmptyState,
  Input,
  KeyboardShortcuts,
  SectionHeader,
  Skeleton,
  useToast,
  type DataTableColumn,
} from '../nightdesk';
import { InventoryTree } from '../components/InventoryTree';
import { getInventoryNode, getSystemsState, searchInventory } from '../api/client';
import { ScreenHeader } from './ScreenHeader';
import { SseInventoryPanel } from './SseInventoryPanel';
import { namesFilterForParam } from '../app/nav';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';

/** Build a shareable Inventory URL (`q` / `node` / `exp`). */
export function buildInventoryShareUrl(opts: {
  q?: string;
  node?: string | null;
  exp?: string[];
  origin?: string;
  pathname?: string;
}): string {
  const origin = opts.origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const pathname = opts.pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/inventory');
  const out = new URLSearchParams();
  const q = (opts.q ?? '').trim();
  if (q.length >= 2) out.set('q', q);
  if (opts.node) out.set('node', opts.node);
  if (opts.exp && opts.exp.length > 0) out.set('exp', opts.exp.join(','));
  const qs = out.toString();
  return `${origin}${pathname}${qs ? `?${qs}` : ''}`;
}

/** Pure live estate map — systems registry non-demo (demo stays quiet). */
export function inventorySectionLive(state: {
  dataSource?: string;
  demoMode?: boolean;
} | null | undefined): boolean {
  if (!state) return false;
  if (state.demoMode === true) return false;
  return state.dataSource !== 'demo';
}

const inventorySearchColumns: Array<DataTableColumn<InventoryTreeNode>> = [
  {
    key: 'label',
    title: 'Match',
    hideable: false,
    sortValue: (node) => node.label,
    render: (node) => (
      <span>
        <strong>{node.label}</strong>
        <small className="nt-hint-muted nt-ml-8">{node.meta ?? node.kind}</small>
      </span>
    ),
  },
  {
    key: 'kind',
    title: 'Kind',
    sortValue: (node) => node.kind,
    render: (node) => (
      <span className="nt-wrap-6">
        <Badge tone={node.tone}>{node.kind}</Badge>
        {node.status !== 'current' ? <Badge tone={node.tone}>{node.status}</Badge> : null}
      </span>
    ),
  },
  {
    key: 'plane',
    title: 'Plane',
    sortValue: (node) => node.identity?.plane ?? '',
    render: (node) => node.identity?.plane ?? <span className="nt-cell-dim">—</span>,
  },
  {
    key: 'serial',
    title: 'Serial',
    sortValue: (node) => node.identity?.serial ?? '',
    render: (node) =>
      node.identity?.serial ? (
        <span className="nt-cell-mono">{node.identity.serial}</span>
      ) : (
        <span className="nt-cell-dim">—</span>
      ),
  },
];

export default function Inventory() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('node');
  const expandedIds = (params.get('exp') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const [selected, setSelected] = useState<InventoryTreeNode | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  /* Search query is shareable via ?q= (min 2 chars). Seed once from the URL so
   * a colleague's link reopens the same search; write-back keeps refresh stable. */
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [results, setResults] = useState<InventoryTreeNode[]>([]);
  /* Keyboard multi-select on search hits raises Export selected / Copy serials /
   * Copy names (unique newline-joined labels — Sites pattern; Loop 223) /
   * Copy selection link (?ids=; Loop 180/184). Selection-empty deep links offer
   * **Clear selection filter** (Loop 208); search empties offer **Clear search**
   * (Loop 204). */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /inventory?q=…&ids=a\nb (bulk Copy selection link). */
  const idsFilter = namesFilterForParam(params.get('ids'));
  const idsFilterSet =
    idsFilter === null ? null : new Set(idsFilter.map((id) => id.trim()).filter(Boolean));
  const viewResults =
    idsFilterSet === null ? results : results.filter((node) => idsFilterSet.has(node.id));
  const idsPresent =
    idsFilterSet === null
      ? 0
      : [...idsFilterSet].filter((id) => results.some((node) => node.id === id)).length;
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchTotal, setSearchTotal] = useState<number | null>(null);
  // Set when a Load More lands on a page that no longer exists. The rows
  // already on screen came from a read of an estate that has since changed,
  // so they stay — deleting them would lose an answer the operator is still
  // reading — but they stop being presented as the whole of anything.
  const [listMoved, setListMoved] = useState(false);
  /* Linked planes the search could not look inside. A miss over an unsearched
   * plane is a false negative, and "No inventory matches" is exactly how an
   * operator asking "is this serial in the estate?" reads a no. */
  const [unsearched, setUnsearched] = useState<string[]>([]);
  const activeSearchRef = useRef('');
  // The SSE write grant lives ENTIRELY in the registry's capability claim
  // (PLANE_WRITE_MODE.sse can never carry it), so this screen reads the same
  // signal the Systems Configuration tab does instead of hard-coding a
  // read-only panel: an operator who granted the write scope must not get a
  // silently weaker view of the same objects here.
  const [sseCanWrite, setSseCanWrite] = useState(false);
  /* LIVE badge honesty: systems/state is the estate registry (no inventory
   * envelope). Demo mode and offline stay quiet; pure live stamps LIVE. */
  const [sectionLive, setSectionLive] = useState(false);

  useEffect(() => {
    let live = true;
    void getSystemsState().then((state) => {
      if (!live) return;
      setSseCanWrite(state?.planes?.sse?.capabilities?.directWrite === true);
      setSectionLive(inventorySectionLive(state));
    });
    return () => {
      live = false;
    };
  }, []);

  /* Clearing the ?node= param clears the panel — adjusted during render so a
     stale node never commits against an address that no longer names it. A
     node-to-node navigation keeps the old node until the new read lands. */
  const [prevSelectedId, setPrevSelectedId] = useState(selectedId);
  if (prevSelectedId !== selectedId) {
    setPrevSelectedId(selectedId);
    if (!selectedId) {
      setSelected(null);
      setSelectionError(null);
    }
  }

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setSelectionError(null);
    void getInventoryNode(selectedId, controller.signal)
      .then((node) => {
        setSelected(node);
        setSelectionError(null);
      })
      .catch((cause) => {
        if ((cause as Error).name !== 'AbortError') {
          setSelected(null);
          setSelectionError((cause as Error).message || 'Inventory node could not be loaded');
        }
      });
    return () => controller.abort();
  }, [selectedId]);

  /* Dropping below two characters abandons the search: the result state is
     cleared during render (it is invisible behind the tree view anyway, and a
     later query must not resurrect it), while the in-flight invalidation stays
     in the effect — the abort and the ref write are what stop a late page. */
  const trimmedQuery = query.trim();
  const queryTooShort = trimmedQuery.length < 2;
  const [prevTooShort, setPrevTooShort] = useState(queryTooShort);
  if (prevTooShort !== queryTooShort) {
    setPrevTooShort(queryTooShort);
    if (queryTooShort) {
      setResults([]);
      setSelectedKeys([]);
      setSearching(false);
      setLoadingMore(false);
      setSearchError(null);
      setNextCursor(null);
      setSearchTotal(null);
      setUnsearched([]);
      setListMoved(false);
    }
  }

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      activeSearchRef.current = '';
      return;
    }
    activeSearchRef.current = q;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      setResults([]);
      setSelectedKeys([]);
      setSearchError(null);
      setNextCursor(null);
      setSearchTotal(null);
      setUnsearched([]);
      setListMoved(false);
      void searchInventory(q, { limit: 50, signal: controller.signal })
        .then((page) => {
          if (activeSearchRef.current !== q) return;
          setResults(page.nodes);
          setNextCursor(page.nextCursor);
          setSearchTotal(page.total);
          setUnsearched(page.unsearchedPlanes ?? []);
        })
        .catch((cause) => {
          if ((cause as Error).name !== 'AbortError') setSearchError((cause as Error).message);
        })
        .finally(() => setSearching(false));
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const loadMore = async () => {
    const q = query.trim();
    const cursor = nextCursor;
    if (!cursor || activeSearchRef.current !== q) return;
    setLoadingMore(true);
    setSearchError(null);
    try {
      const page = await searchInventory(q, { cursor, limit: 50 });
      if (activeSearchRef.current !== q) return;
      // No rows and no next cursor is what the end of the list looks like AND
      // what a vanished page looks like. Only the server can tell them apart,
      // so take its word rather than inferring from the empty page.
      if (page.cursorState === 'past-end') setListMoved(true);
      setResults((current) => {
        const known = new Set(current.map((node) => node.id));
        return [...current, ...page.nodes.filter((node) => !known.has(node.id))];
      });
      setNextCursor(page.nextCursor);
      setSearchTotal(page.total);
    } catch (cause) {
      if (activeSearchRef.current === q) setSearchError((cause as Error).message);
    } finally {
      if (activeSearchRef.current === q) setLoadingMore(false);
    }
  };

  /* Keep ?q= aligned with the search box (shareable / refresh-stable). Empty
   * or short queries drop the param rather than writing q=. node/exp stay. */
  useEffect(() => {
    const next = new URLSearchParams(params);
    const qTrim = query.trim();
    if (qTrim.length >= 2) next.set('q', qTrim);
    else next.delete('q');
    if (next.toString() === params.toString()) return;
    setParams(next, { replace: true });
  }, [query, params, setParams]);

  const writeInventoryParams = (next: { node?: string | null; exp?: string[]; clearQ?: boolean }) => {
    const out = new URLSearchParams(params);
    if (next.node !== undefined) {
      if (next.node) out.set('node', next.node);
      else out.delete('node');
    }
    if (next.exp !== undefined) {
      if (next.exp.length > 0) out.set('exp', next.exp.join(','));
      else out.delete('exp');
    }
    if (next.clearQ) out.delete('q');
    setParams(out, { replace: true });
  };

  const choose = (node: InventoryTreeNode) => {
    if (node.kind === 'sse-kind' || node.kind === 'sse-object' || node.kind === 'system' || node.kind === 'group') {
      setQuery('');
      setSelected(node);
      writeInventoryParams({ node: node.id, clearQ: true });
      return;
    }
    if (node.target) navigate(node.target);
  };

  return (
    <div className="nt-inventory nt-recon-reveal nt-inventory-shell nt-section-panel">
      <ScreenHeader
        overline="Inventory / Explorer"
        title="Inventory explorer"
        subtitle="Browse connected systems, sites, devices, and SSE objects without loading the entire estate at once."
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · estate map
            </span>
            {/* LIVE when the systems registry is non-demo — offline/demo stay quiet (Loop 171). */}
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  // No dedicated /api/inventory/export — device rows are the
                  // portal inventory CSV (same source as Devices screen). When
                  // the explorer search is active (min 2 chars), pass q= so the
                  // CSV matches the same substring Devices export uses.
                  const qs = new URLSearchParams();
                  const qTrim = query.trim();
                  if (qTrim.length >= 2) qs.set('q', qTrim);
                  const suffix = qs.toString() ? `?${qs.toString()}` : '';
                  const res = await downloadApiCsv(`/api/devices/export${suffix}`, 'devices.csv');
                  if (res.ok) {
                    toast('Server CSV downloaded', {
                      description: qTrim.length >= 2
                        ? `devices.csv — portal inventory matching q=${qTrim}.`
                        : 'devices.csv — portal device inventory export.',
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const url = buildInventoryShareUrl({
                  q: query,
                  node: selectedId,
                  exp: expandedIds,
                });
                void navigator.clipboard.writeText(url).then(
                  () =>
                    toast('View link copied', {
                      description: query.trim().length >= 2 ? `q=${query.trim()}` : window.location.search || 'inventory',
                      tone: 'success',
                    }),
                  () => toast('Could not copy link', { tone: 'danger' }),
                );
              }}
            >
              Copy view link
            </Button>
            {/* Search results are a keyboard grid (j/k/x/Enter) — surface the map (Loop 198). */}
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </>
        }
      />
      <div className="nt-plane-theater" role="note">NightDesk · estate map · tree · reconcile cinema</div>
      <VisualReferencePanel target={{ kind: 'estate', id: 'inventory' }} editable={false} />
      <ConfigRecommendationsPanel title="Inventory recommendations" limit={5} />
      <div className="nt-inventory__search">
        <Input
          mono
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search systems, sites, devices, serials, or SSE objects…"
          aria-label="Search inventory"
        />
      </div>
      {query.trim().length >= 2 ? (
        <div>
          <div className="nt-row-between-wrap">
            <SectionHeader
              label="Search results"
              meta={
                // "50 OF 40" once the estate shrinks under a paged read. The
                // two numbers came from two different reads, so pairing them
                // states a ratio that was never true of either.
                searchTotal === null || listMoved ? `${results.length} SHOWN` : `${results.length} OF ${searchTotal}`
              }
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={results.length === 0}
              onClick={() => {
                const n = exportTableCsv(
                  'inventory-search',
                  ['id', 'kind', 'label', 'meta', 'status', 'plane', 'serial', 'siteId', 'target'],
                  results.map((node) => [
                    node.id,
                    node.kind,
                    node.label,
                    node.meta ?? '',
                    node.status,
                    node.identity?.plane ?? '',
                    node.identity?.serial ?? '',
                    node.identity?.siteId ?? '',
                    node.target ?? '',
                  ]),
                );
                toast(
                  n === 0
                    ? 'No results to export'
                    : `Exported ${countOf(n, 'result')} (loaded search page${listMoved ? ' · list may have moved' : ''})`,
                  { tone: n === 0 ? 'warning' : 'success' },
                );
              }}
            >
              Export CSV
            </Button>
          </div>
          {searching ? (
            <div role="status" aria-label="Searching inventory" className="nt-stack nt-gap-8">
              <Skeleton height={14} width="40%" />
              <Skeleton height={36} />
              <Skeleton height={36} />
              <Skeleton height={36} />
            </div>
          ) : null}
          {searchError ? <EmptyState title="Inventory search unavailable" description={searchError} /> : null}
          {!searching && !searchError && listMoved ? (
            <Alert tone="warning" title="The inventory changed while these results were being paged">
              <span className="nt-fs-13">
                The next page no longer exists — the estate shrank between reads, which is what happens when a plane
                goes stale or unlinks mid-search. The {countOf(results.length, 'result')} below
                came from the earlier read and may name objects that have since left the cache; anything added since is
                not here. Search again for the current estate.
              </span>
            </Alert>
          ) : null}
          {!searching && !searchError && unsearched.length > 0 ? (
            <Alert tone="warning" title={`${unsearched.join(', ')} could not be searched`}>
              <span className="nt-fs-13">
                Their read has not come back, so nothing they hold was looked at. A miss below does not mean the object
                is absent from the estate.
              </span>
            </Alert>
          ) : null}
          {!searching && !searchError && results.length === 0 ? (
            <EmptyState
              title={unsearched.length > 0 ? 'No matches in the planes that could be searched' : 'No inventory matches'}
              description={
                unsearched.length > 0
                  ? // Not "no matches": the planes above were never asked.
                    `Nothing matched in the planes that answered. ${unsearched.join(', ')} could not be searched, so this is not a complete answer.`
                  : 'Try a system, site, device name, serial, or SSE object.'
              }
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setSelectedKeys([]);
                  writeInventoryParams({ clearQ: true });
                }}
              >
                Clear search
              </Button>
            </EmptyState>
          ) : null}
          {results.length > 0 ? (
            <>
              {idsFilterSet !== null ? (
                <div className="nt-chip-row" role="group" aria-label="Selection deep link">
                  <button
                    type="button"
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.delete('ids');
                      setParams(next, { replace: true });
                      setSelectedKeys([]);
                    }}
                    title={idsFilter?.join(', ')}
                    className="nt-chip nt-chip--active"
                  >
                    {idsPresent === idsFilterSet.size
                      ? `${idsFilterSet.size} selected id${idsFilterSet.size === 1 ? '' : 's'}`
                      : `${idsPresent} of ${idsFilterSet.size} selected ids present`}
                    {' — clear'}
                  </button>
                </div>
              ) : null}
              {viewResults.length === 0 ? (
                <div className="nt-stack nt-gap-8">
                  <div className="nt-service-note">
                    No search hits match the selection deep link — clear the selection filter to
                    restore the loaded results.
                  </div>
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const next = new URLSearchParams(params);
                        next.delete('ids');
                        setParams(next, { replace: true });
                        setSelectedKeys([]);
                      }}
                    >
                      Clear selection filter
                    </Button>
                  </div>
                </div>
              ) : (
                <DataTable
                  ariaLabel="Inventory search results"
                  density="compact"
                  className="nt-inventory-results"
                  columns={inventorySearchColumns}
                  rows={viewResults}
                  rowKey={(node) => node.id}
                  selectedKeys={selectedKeys}
                  onSelectionChange={setSelectedKeys}
                  onRowActivate={choose}
                />
              )}
              {selectedKeys.length > 0 ? (
                <div
                  className="nt-configure-bulk-bar nt-bulk-glass"
                  role="region"
                  aria-label="Inventory search selection actions"
                >
                  <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
                  <span className="nt-configure-bulk-bar__hint">
                    export, copy serials / names, or share a selection link for only the hits you marked — full page export stays in the header · Enter opens the focused row
                  </span>
                  <span className="nt-configure-bulk-bar__actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const selected = new Set(selectedKeys);
                        const picked = viewResults.filter((node) => selected.has(node.id));
                        if (picked.length === 0) {
                          toast('No selected results still in view', {
                            description: 'Clear selection or run the search again.',
                            tone: 'info',
                          });
                          return;
                        }
                        const n = exportTableCsv(
                          'inventory-search-selected.csv',
                          ['id', 'kind', 'label', 'meta', 'status', 'plane', 'serial', 'siteId', 'target'],
                          picked.map((node) => [
                            node.id,
                            node.kind,
                            node.label,
                            node.meta ?? '',
                            node.status,
                            node.identity?.plane ?? '',
                            node.identity?.serial ?? '',
                            node.identity?.siteId ?? '',
                            node.target ?? '',
                          ]),
                        );
                        toast(`Exported ${countOf(n, 'selected result')}`, {
                          description: 'inventory-search-selected.csv — loaded search page fields only.',
                          tone: 'success',
                        });
                      }}
                    >
                      Export selected
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void (async () => {
                          const selected = new Set(selectedKeys);
                          const picked = viewResults.filter((node) => selected.has(node.id));
                          if (picked.length === 0) {
                            toast('No selected results still in view', {
                              description: 'Clear selection or run the search again.',
                              tone: 'info',
                            });
                            return;
                          }
                          const serials = [
                            ...new Set(
                              picked
                                .map((node) => (node.identity?.serial ?? '').trim())
                                .filter((serial) => serial && serial !== '—'),
                            ),
                          ];
                          if (serials.length === 0) {
                            toast('No serials on the selected results', {
                              description: 'Those hits did not publish a serial — export CSV for ids/labels instead.',
                              tone: 'info',
                            });
                            return;
                          }
                          const text = serials.join('\n');
                          try {
                            await navigator.clipboard.writeText(text);
                            toast(`Copied ${countOf(serials.length, 'serial')}`, {
                              description:
                                serials.length < picked.length
                                  ? `${picked.length - serials.length} selected without a serial skipped`
                                  : 'newline-joined · paste into a ticket or RMA',
                              tone: 'success',
                            });
                          } catch {
                            toast('Could not copy serials', { description: text, tone: 'warning' });
                          }
                        })();
                      }}
                    >
                      Copy serials
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void (async () => {
                          const selected = new Set(selectedKeys);
                          const picked = viewResults.filter((node) => selected.has(node.id));
                          if (picked.length === 0) {
                            toast('No selected results still in view', {
                              description: 'Clear selection or run the search again.',
                              tone: 'info',
                            });
                            return;
                          }
                          const names = [
                            ...new Set(
                              picked
                                .map((node) => (node.label ?? '').trim())
                                .filter((name) => name && name !== '—'),
                            ),
                          ];
                          if (names.length === 0) {
                            toast('No names on the selected results', {
                              description: 'Those hits did not publish a label — export CSV instead.',
                              tone: 'info',
                            });
                            return;
                          }
                          const text = names.join('\n');
                          try {
                            await navigator.clipboard.writeText(text);
                            toast(`Copied ${countOf(names.length, 'name')}`, {
                              description:
                                names.length < picked.length
                                  ? `${picked.length - names.length} selected without a label skipped`
                                  : 'newline-joined · paste into a ticket or change window',
                              tone: 'success',
                            });
                          } catch {
                            toast('Could not copy names', { description: text, tone: 'warning' });
                          }
                        })();
                      }}
                    >
                      Copy names
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void (async () => {
                          const selected = new Set(selectedKeys);
                          const picked = viewResults.filter((node) => selected.has(node.id));
                          if (picked.length === 0) {
                            toast('No selected results still in view', {
                              description: 'Clear selection or run the search again.',
                              tone: 'info',
                            });
                            return;
                          }
                          const ids = [
                            ...new Set(picked.map((node) => node.id.trim()).filter(Boolean)),
                          ];
                          if (ids.length === 0) {
                            toast('No ids on the selected results', {
                              description: 'Those hits did not publish an id — export CSV instead.',
                              tone: 'info',
                            });
                            return;
                          }
                          const next = new URLSearchParams(params);
                          next.set('ids', ids.join('\n'));
                          const qs = next.toString();
                          const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                          try {
                            await navigator.clipboard.writeText(url);
                            toast('Selection link copied', {
                              description: `${ids.length} id${ids.length === 1 ? '' : 's'} · ids=`,
                              tone: 'success',
                            });
                          } catch {
                            toast('Could not copy link', { description: url, tone: 'warning' });
                          }
                        })();
                      }}
                    >
                      Copy selection link
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                      Clear
                    </Button>
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
          {nextCursor ? (
            <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          className={
            selected || selectionError
              ? 'nt-inventory__layout'
              : 'nt-inventory__layout nt-inventory__layout--browse'
          }
        >
          <section className="nt-inventory__tree-panel" aria-label="Inventory hierarchy">
            <div className="nt-inventory__panel-head">
              <SectionHeader label="Hierarchy" meta="LAZY · PAGED" />
            </div>
            <div className="nt-inventory__panel-body">
              <InventoryTree
                compact={false}
                selectedId={selectedId}
                onSelect={choose}
                expandedIds={expandedIds}
                onExpandedChange={(ids) => writeInventoryParams({ exp: ids })}
              />
            </div>
            {/* Before anything is picked there is no detail to show, so the
                hierarchy takes the whole width instead of sitting in a third
                of it beside an empty panel. The hints ride along as a strip. */}
            {selected || selectionError ? null : (
              <ul className="nt-inventory__hint">
                <li>
                  <strong>Expand a system</strong>
                  Children load one page at a time — the estate is never pulled in full.
                </li>
                <li>
                  <strong>Search anything</strong>
                  Names, serials, MACs and SSE object IDs, matched server-side.
                </li>
                <li>
                  <strong>Sites and devices</strong>
                  Open their existing specialist views; SSE objects open here.
                </li>
              </ul>
            )}
          </section>
          {selected || selectionError ? (
          <section className="nt-inventory__detail" aria-label="Selected inventory node">
            <div className="nt-inventory__panel-head">
              <SectionHeader
                label={selected ? selected.label : 'Selection'}
                meta={selected ? selected.kind.toUpperCase() : selectionError ? 'UNAVAILABLE' : undefined}
              />
            </div>
            <div className="nt-inventory__panel-body">
              {selectionError && !selected ? (
                <EmptyState
                  title="Inventory node unavailable"
                  description={selectionError}
                />
              ) : selected?.identity?.plane === 'sse' ? (
                <SseInventoryPanel
                  key={selected.id}
                  canWrite={sseCanWrite}
                  initialKind={selected.identity.sseKind as SseObjectKind | undefined}
                  initialObjectId={selected.identity.objectId}
                />
              ) : selected ? (
                <div className="nt-inventory__selection">
                  <Badge tone={selected.tone}>{selected.status}</Badge>
                  <h2>{selected.label}</h2>
                  <p>{selected.meta ?? `${selected.childCount ?? 0} child resources`}</p>
                  {selected.target && selected.target !== `/inventory?node=${encodeURIComponent(selected.id)}` ? (
                    <Button variant="secondary" onClick={() => navigate(selected.target!)}>
                      Open specialist view
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
