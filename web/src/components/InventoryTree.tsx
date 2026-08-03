import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { InventoryTreeNode, InventoryTreePage } from '@hpe/shared';
import { Badge, Spinner } from '../nightdesk';
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
}: {
  compact?: boolean;
  selectedId?: string | null;
  onSelect?: (node: InventoryTreeNode) => void;
}) {
  const navigate = useNavigate();
  const branchKey = (parentId: string | null) => parentId ?? '__root__';
  const [branches, setBranches] = useState<Record<string, BranchPage>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The root read starts out marked: the mount effect below owns it, and a
  // synchronous setState from an effect body is a cascading render. Seeding
  // the mark here means the first committed frame already shows the spinner
  // rather than an empty tree waiting on the effect to say it is loading.
  const [loading, setLoading] = useState<Set<string>>(() => new Set([branchKey(null)]));
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());

  /** Folds a fetched page into branch state. The root page also expands and
   *  focuses its first node; that node's own read is kicked off by the
   *  fetchBranch continuation that revealed it. */
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
      setExpanded((current) => new Set(current).add(page.nodes[0]!.id));
      setFocusId((current) => current ?? page.nodes[0]!.id);
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
        applyPage(parentId, page, append);
        // The tree opens grown one level: the first root node's branch read
        // starts here, in the continuation that revealed the node.
        const first = parentId === null ? page.nodes[0] : undefined;
        if (first && !branches[first.id]) {
          setLoading((current) => new Set(current).add(first.id));
          void fetchBranch(first.id, false);
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
      <div role="status" aria-label="Loading inventory">
        <Spinner />
      </div>
    );
  }

  return (
    <div className={`nt-inventory-tree${compact ? ' nt-inventory-tree--compact' : ''}`}>
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
                className={`nt-inventory-tree__row${selectedId === node.id ? ' nt-inventory-tree__row--selected' : ''}`}
                style={{ paddingLeft: 6 + (level - 1) * 14 }}
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
                <div className="nt-inventory-tree__loading" style={{ paddingLeft: 34 + level * 14 }}>
                  loading…
                </div>
              ) : null}
              {expanded.has(node.id) && branch?.nextCursor ? (
                <button
                  type="button"
                  className="nt-inventory-tree__more"
                  style={{ paddingLeft: 34 + level * 14 }}
                  onClick={() => void load(node.id, true)}
                >
                  Load more
                </button>
              ) : null}
              {expanded.has(node.id) && branch?.moved ? (
                // Without this the button simply disappears, which reads as
                // "that was all of them" over a branch that got shorter.
                <div className="nt-inventory-tree__loading" style={{ paddingLeft: 34 + level * 14 }}>
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
