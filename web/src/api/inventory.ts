/** GreenLake inventory tree: lazy node expansion and search. */

import {
  type InventorySearchPage,
  type InventoryTreeNode,
  type InventoryTreePage,
} from '@hpe/shared';

export async function getInventoryTree(
  options: {
    parent?: string | null;
    query?: string;
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<InventoryTreePage> {
  const params = new URLSearchParams();
  if (options.parent) params.set('parent', options.parent);
  if (options.query) params.set('q', options.query);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  const response = await fetch(`/api/inventory/tree?${params.toString()}`, {
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`inventory tree failed — HTTP ${response.status}`);
  return (await response.json()) as InventoryTreePage;
}

export async function searchInventory(
  query: string,
  options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<InventorySearchPage> {
  const params = new URLSearchParams({ q: query });
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  const response = await fetch(`/api/inventory/search?${params.toString()}`, {
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`inventory search failed — HTTP ${response.status}`);
  return (await response.json()) as InventorySearchPage;
}

export async function getInventoryNode(id: string, signal?: AbortSignal): Promise<InventoryTreeNode> {
  const response = await fetch(`/api/inventory/node?id=${encodeURIComponent(id)}`, { signal });
  if (!response.ok) throw new Error(`inventory node failed — HTTP ${response.status}`);
  return (await response.json()) as InventoryTreeNode;
}
