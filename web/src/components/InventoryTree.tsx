import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import type { InventoryTreeNode, InventoryTreePage } from '@hpe/shared';
import { Badge, Skeleton } from '../nightdesk';
import { getInventoryTree } from '../api/client';

interface BranchPage {
  nodes: InventoryTreeNode[];
  nextCursor: string | null;
  /** A Load More landed on a page the branch no longer has. The rows already
   *  fetched stay — they are still the best answer anyone has — but the
   *  branch stops looking like a complete listing of its parent. */
  moved: boolean;
}

export function InventoryTree({
  compact = false,
  selectedId = null,
  onSelect,
  expandedIds,
  onExpandedChange,
}: {
  compact?: boolean;
  selectedId?: string | null;
  onSelect?: (node: InventoryTreeNode) => void;
  /** Optional shareable expand set (e.g. from `?exp=`). When provided, seeds
   *  open branches on first paint; subsequent toggles still call
   *  onExpandedChange so the parent can keep the URL in sync. */
  expandedIds?: string[];
  onExpandedChange?: (ids: string[]) => void;
}) {
  const navigate = useNavigate();
  const branchKey = (parentId: string | null) => parentId ?? '__root__';
  const [branches, setBranches] = useState<Record<string, BranchPage>>({});
  const seededExpand = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    if (expandedIds && expandedIds.length > 0) {
      seededExpand.current = true;
      return new Set(expandedIds);
    }
    return new Set();
  });
  // The root read starts out marked: the mount effect below owns it, and a
  // synchronous setState from an effect body is a cascading render. Seeding
  // the mark here means the first committed frame already shows the spinner
  // rather than an empty tree waiting on the effect to say it is loading.
  const [loading, setLoading] = useState<Set<string>>(() => new Set([branchKey(null)]));
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const onExpandedChangeRef = useRef(onExpandedChange);
  onExpandedChangeRef.current = onExpandedChange;

  const publishExpanded = (next: Set<string>) => {
    onExpandedChangeRef.current?.([...next]);
  };

  /** Folds a fetched page into branch state. The root page also expands and
   *  focuses its first node when the operator has not already shared an
   *  expand set; that node's own read is kicked off by the fetchBranch
   *  continuation that revealed it. */
  const applyPage = (parentId: string | null, page: InventoryTreePage, append: boolean) => {
    const key = branchKey(parentId);
    setBranches((current) => ({
      ...current,
      [key]: {
        nodes: append ? [...(current[key]?.nodes ?? []), ...page.nodes] : page.nodes,
        nextCursor: page.nextCursor,
        // An empty final page is indistinguishable from a vanished one on
        // the wire, so this is the server's answer, not an inference. A
        // fresh (non-append) read starts the branch clean again.
        moved: append ? (current[key]?.moved ?? false) || page.cursorState === 'past-end' : false,
      },
    }));
    if (parentId === null && page.nodes[0]) {
      setFocusId((current) => current ?? page.nodes[0]!.id);
      if (!seededExpand.current) {
        seededExpand.current = true;
        setExpanded((current) => {
          if (current.size > 0) return current;
          const next = new Set(current).add(page.nodes[0]!.id);
          publishExpanded(next);
          return next;
        });
      }
    }
  };

  /** Reads one branch page and folds it in. Every state write happens in a
   *  continuation, so the mount effect can own the root read with a real
   *  abort cleanup; event-driven callers go through `load`, which marks the
   *  branch loading up front. An aborted read leaves no trace — no page, no
   *  error — and keeps its loading mark for the effect run that replaces it. */
  const fetchBranch = (parentId: string | null, append: boolean, signal?: AbortSignal): Promise<void> => {
    const key = branchKey(parentId);
    return getInventoryTree({
      parent: parentId,
      cursor: append ? branches[key]?.nextCursor : null,
      limit: compact ? 25 : 50,
      signal,
    })
      .then((page) => {
        if (signal?.aborted) return;
        // Capture whether a shared expand set already owns the open branches
        // before applyPage may seed the default first-root expand.
        const hadSeededExpand = seededExpand.current;
        applyPage(parentId, page, append);
        // Prefetch children for the default first-root expand and for any
        // shared expand ids that land on this page.
        const prefetchIds = new Set<string>();
        if (parentId === null && page.nodes[0] && !hadSeededExpand) {
          prefetchIds.add(page.nodes[0].id);
        }
        for (const node of page.nodes) {
          if (node.hasChildren && (expanded.has(node.id) || expandedIds?.includes(node.id))) {
            prefetchIds.add(node.id);
          }
        }
        for (const id of prefetchIds) {
          if (!branches[id]) {
            setLoading((current) => new Set(current).add(id));
            void fetchBranch(id, false);
          }
        }
      })
      .catch((cause) => {
        if (signal?.aborted || (cause as Error).name === 'AbortError') return;
        setError((cause as Error).message);
      })
      .finally(() => {
        if (signal?.aborted) return;
        setLoading((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
  };

  /** Event-driven read (expand, Load more): marks the branch loading up
   *  front so a second click cannot start the same read twice. */
  const load = (parentId: string | null, append = false): Promise<void> => {
    const key = branchKey(parentId);
    if (loading.has(key)) return Promise.resolve();
    setLoading((current) => new Set(current).add(key));
    setError(null);
    return fetchBranch(parentId, append);
  };

  // The tree owns its first bounded read, with a real abort cleanup:
  // StrictMode's mount/cleanup/mount cycle (or a genuine unmount) cancels
  // the in-flight root read instead of letting it set state into a tree
  // that is gone. Child reads are event-driven.
  useEffect(() => {
    const controller = new AbortController();
    void fetchBranch(null, false, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    const rows: Array<{ node: InventoryTreeNode; level: number }> = [];
    const walk = (parentId: string | null, level: number) => {
      for (const node of branches[branchKey(parentId)]?.nodes ?? []) {
        rows.push({ node, level });
        if (expanded.has(node.id)) walk(node.id, level + 1);
      }
    };
    walk(null, 1);
    return rows;
  }, [branches, expanded]);

  const toggle = async (node: InventoryTreeNode) => {
    if (!node.hasChildren) return;
    const opening = !expanded.has(node.id);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(node.id);
      else next.delete(node.id);
      publishExpanded(next);
      return next;
    });
    if (opening && !branches[node.id]) await load(node.id);
  };

  const choose = (node: InventoryTreeNode) => {
    setFocusId(node.id);
    if (onSelect) {
      onSelect(node);
      return;
    }
    if (node.target) navigate(node.target);
    else void toggle(node);
  };

  const focusAt = (index: number) => {
    const row = visible[Math.max(0, Math.min(visible.length - 1, index))];
    if (!row) return;
    setFocusId(row.node.id);
    requestAnimationFrame(() => refs.current.get(row.node.id)?.focus());
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, node: InventoryTreeNode) => {
    const index = visible.findIndex((row) => row.node.id === node.id);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAt(visible.length - 1);
    } else if (event.key === 'ArrowRight' && node.hasChildren) {
      event.preventDefault();
      if (!expanded.has(node.id)) void toggle(node);
      else focusAt(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (expanded.has(node.id)) void toggle(node);
      else if (node.parentId) {
        const parentIndex = visible.findIndex((row) => row.node.id === node.parentId);
        if (parentIndex >= 0) focusAt(parentIndex);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(node);
    }
  };

  if (!branches.__root__ && loading.has('__root__')) {
    return (
      <div role="status" aria-label="Loading inventory" className="nt-debug-wake">
        <span className="nt-chat-pending__pulse" aria-hidden />
        <div className="nt-stack nt-gap-6 nt-flex-1">
          <Skeleton height={12} width="44%" />
          <Skeleton height={22} width="78%" />
          <Skeleton height={22} width="62%" />
          <Skeleton height={22} width="70%" />
        </div>
        <span className="nt-hint-muted nt-chat-pending__label">NightDesk · inventory tree…</span>
      </div>
    );
  }

  return (
    <div className={`nt-inventory-tree nt-inventory-tree-shell${compact ? ' nt-inventory-tree--compact' : ''}`}>
      {error ? <div className="nt-inventory-tree__error">{error}</div> : null}
      <div role="tree" aria-label="Inventory hierarchy">
        {visible.map(({ node, level }, index) => {
          const branch = branches[node.id];
          return (
            <div key={node.id}>
              <div
                ref={(element) => {
                  if (element) refs.current.set(node.id, element);
                  else refs.current.delete(node.id);
                }}
                role="treeitem"
                aria-level={level}
                aria-posinset={index + 1}
                aria-setsize={visible.length}
                aria-selected={selectedId === node.id}
                aria-expanded={node.hasChildren ? expanded.has(node.id) : undefined}
                tabIndex={focusId === node.id || (!focusId && index === 0) ? 0 : -1}
                className={`nt-inventory-tree__row nt-inventory-tree__node nt-card-lift${selectedId === node.id ? ' nt-inventory-tree__row--selected' : ''}`}
                data-active={selectedId === node.id ? 'true' : undefined}
                style={{ ['--nd-tree-level' as string]: level } as CSSProperties}
                onFocus={() => setFocusId(node.id)}
                onKeyDown={(event) => onKeyDown(event, node)}
              >
                <button
                  type="button"
                  className="nt-inventory-tree__toggle"
                  aria-label={`${expanded.has(node.id) ? 'Collapse' : 'Expand'} ${node.label}`}
                  disabled={!node.hasChildren}
                  onClick={() => void toggle(node)}
                >
                  {node.hasChildren ? (expanded.has(node.id) ? '−' : '+') : '·'}
                </button>
                <button
                  type="button"
                  className="nt-inventory-tree__label"
                  title={node.meta}
                  onClick={() => choose(node)}
                >
                  <span>{node.label}</span>
                  {!compact && node.meta ? <small>{node.meta}</small> : null}
                </button>
                {node.count !== undefined ? <span className="nt-inventory-tree__count">{node.count}</span> : null}
                {node.status !== 'current' ? <Badge tone={node.tone}>{node.status}</Badge> : null}
              </div>
              {expanded.has(node.id) && loading.has(node.id) ? (
                <div className="nt-inventory-tree__loading" style={{ ['--nd-tree-level' as string]: level } as CSSProperties}>
                  loading…
                </div>
              ) : null}
              {expanded.has(node.id) && branch?.nextCursor ? (
                <button
                  type="button"
                  className="nt-inventory-tree__more"
                  style={{ ['--nd-tree-level' as string]: level } as CSSProperties}
                  onClick={() => void load(node.id, true)}
                >
                  Load more
                </button>
              ) : null}
              {expanded.has(node.id) && branch?.moved ? (
                // Without this the button simply disappears, which reads as
                // "that was all of them" over a branch that got shorter.
                <div className="nt-inventory-tree__loading" style={{ ['--nd-tree-level' as string]: level } as CSSProperties}>
                  list changed while loading — collapse and reopen for the current children
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
