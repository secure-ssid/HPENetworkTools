import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { InventoryTreeNode, SseObjectKind } from '@hpe/shared';
import { countOf } from '@hpe/shared';
import { Alert, Badge, Button, EmptyState, Input, SectionHeader, Spinner } from '../nightdesk';
import { InventoryTree } from '../components/InventoryTree';
import { getInventoryNode, getSystemsState, searchInventory } from '../api/client';
import { ScreenHeader } from './ScreenHeader';
import { SseInventoryPanel } from './SseInventoryPanel';

export default function Inventory() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('node');
  const [selected, setSelected] = useState<InventoryTreeNode | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InventoryTreeNode[]>([]);
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

  useEffect(() => {
    let live = true;
    void getSystemsState().then((state) => {
      if (live) setSseCanWrite(state?.planes?.sse?.capabilities?.directWrite === true);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const controller = new AbortController();
    void getInventoryNode(selectedId, controller.signal)
      .then(setSelected)
      .catch((cause) => {
        if ((cause as Error).name !== 'AbortError') setSelected(null);
      });
    return () => controller.abort();
  }, [selectedId]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      activeSearchRef.current = '';
      setResults([]);
      setSearching(false);
      setLoadingMore(false);
      setSearchError(null);
      setNextCursor(null);
      setSearchTotal(null);
      setUnsearched([]);
      setListMoved(false);
      return;
    }
    activeSearchRef.current = q;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      setResults([]);
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

  const choose = (node: InventoryTreeNode) => {
    if (node.kind === 'sse-kind' || node.kind === 'sse-object' || node.kind === 'system' || node.kind === 'group') {
      setQuery('');
      setSelected(node);
      setParams({ node: node.id });
      return;
    }
    if (node.target) navigate(node.target);
  };

  return (
    <div className="nt-inventory">
      <ScreenHeader
        overline="Inventory / Explorer"
        title="Inventory explorer"
        subtitle="Browse connected systems, sites, devices, and SSE objects without loading the entire estate at once."
      />
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
          <SectionHeader
            label="Search results"
            meta={
              // "50 OF 40" once the estate shrinks under a paged read. The
              // two numbers came from two different reads, so pairing them
              // states a ratio that was never true of either.
              searchTotal === null || listMoved ? `${results.length} SHOWN` : `${results.length} OF ${searchTotal}`
            }
          />
          {searching ? (
            <div role="status" aria-label="Searching inventory">
              <Spinner />
            </div>
          ) : null}
          {searchError ? <EmptyState title="Inventory search unavailable" description={searchError} /> : null}
          {!searching && !searchError && listMoved ? (
            <Alert tone="warning" title="The inventory changed while these results were being paged">
              <span style={{ fontSize: 13 }}>
                The next page no longer exists — the estate shrank between reads, which is what happens when a plane
                goes stale or unlinks mid-search. The {countOf(results.length, 'result')} below
                came from the earlier read and may name objects that have since left the cache; anything added since is
                not here. Search again for the current estate.
              </span>
            </Alert>
          ) : null}
          {!searching && !searchError && unsearched.length > 0 ? (
            <Alert tone="warning" title={`${unsearched.join(', ')} could not be searched`}>
              <span style={{ fontSize: 13 }}>
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
            />
          ) : null}
          <div className="nt-inventory-results">
            {results.map((node) => (
              <button key={node.id} type="button" className="nt-inventory-result" onClick={() => choose(node)}>
                <span>
                  <strong>{node.label}</strong>
                  <small>{node.meta ?? node.kind}</small>
                </span>
                <span>
                  <Badge tone={node.tone}>{node.kind}</Badge>
                  {node.status !== 'current' ? <Badge tone={node.tone}>{node.status}</Badge> : null}
                </span>
              </button>
            ))}
          </div>
          {nextCursor ? (
            <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className={selected ? 'nt-inventory__layout' : 'nt-inventory__layout nt-inventory__layout--browse'}>
          <section className="nt-inventory__tree-panel" aria-label="Inventory hierarchy">
            <div className="nt-inventory__panel-head">
              <SectionHeader label="Hierarchy" meta="LAZY · PAGED" />
            </div>
            <div className="nt-inventory__panel-body">
              <InventoryTree compact={false} selectedId={selectedId} onSelect={choose} />
            </div>
            {/* Before anything is picked there is no detail to show, so the
                hierarchy takes the whole width instead of sitting in a third
                of it beside an empty panel. The hints ride along as a strip. */}
            {selected ? null : (
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
          {selected ? (
          <section className="nt-inventory__detail" aria-label="Selected inventory node">
            <div className="nt-inventory__panel-head">
              <SectionHeader label={selected ? selected.label : 'Selection'} meta={selected ? selected.kind.toUpperCase() : undefined} />
            </div>
            <div className="nt-inventory__panel-body">
              {selected?.identity?.plane === 'sse' ? (
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
