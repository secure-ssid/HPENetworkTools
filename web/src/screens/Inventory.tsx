import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { InventoryTreeNode, SseObjectKind } from '../../../shared';
import { Badge, Button, EmptyState, Input, SectionHeader, Spinner } from '../nightdesk';
import { InventoryTree } from '../components/InventoryTree';
import { getInventoryNode, searchInventory } from '../api/client';
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
  const activeSearchRef = useRef('');

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
      void searchInventory(q, { limit: 50, signal: controller.signal })
        .then((page) => {
          if (activeSearchRef.current !== q) return;
          setResults(page.nodes);
          setNextCursor(page.nextCursor);
          setSearchTotal(page.total);
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
            meta={searchTotal === null ? `${results.length} SHOWN` : `${results.length} OF ${searchTotal}`}
          />
          {searching ? (
            <div role="status" aria-label="Searching inventory">
              <Spinner />
            </div>
          ) : null}
          {searchError ? <EmptyState title="Inventory search unavailable" description={searchError} /> : null}
          {!searching && !searchError && results.length === 0 ? (
            <EmptyState title="No inventory matches" description="Try a system, site, device name, serial, or SSE object." />
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
                  canWrite={false}
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
