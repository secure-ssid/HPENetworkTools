import { Router, type Request } from 'express';
import {
  DEVICES,
  SITES,
  SYSTEMS,
  SSE_OBJECT_KIND_LABELS,
  SSE_OBJECT_KINDS,
  type DeviceRow,
  type InventoryNodeReadState,
  type InventorySearchPage,
  type InventoryTreeNode,
  type InventoryTreePage,
  type SiteRow,
  type SseKindReadStatus,
  type SseObjectKind,
  type Tone,
} from '../../../shared';
import { registry } from '../planes/registry';
import { PLANE_IDS, type PlaneId, type PlanePull } from '../planes/types';
import { poller } from '../services/poller';
import { settings } from '../config/settings';

export const inventoryRouter = Router();

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const SYSTEMS_ROOT = 'group:systems';
/** Planes that were never given credentials collapse behind one node. Ten
 *  planes ship today and every new adapter adds another; listing eight
 *  "no credentials configured" rows ahead of the two that answer buries the
 *  estate the operator actually has. */
const DORMANT_ROOT = 'group:dormant';

const SYSTEM_LABEL: Record<PlaneId, string> = {
  central: 'HPE Aruba Central',
  classic: 'Central Classic',
  mist: 'Mist',
  greenlake: 'GreenLake',
  aos8: 'AOS-8 mobility master',
  aos10: 'AOS-10 (via Central)',
  local: 'Local switch collector',
  clearpass: 'ClearPass',
  uxi: 'UXI',
  sse: 'HPE Aruba Networking SSE',
};

const DEVICE_PLANE: Record<PlaneId, string> = {
  central: 'CENTRAL',
  classic: 'CLASSIC',
  mist: 'MIST',
  greenlake: 'GREENLAKE',
  aos8: 'AOS-8',
  aos10: 'AOS-10',
  local: 'LOCAL',
  clearpass: 'CLEARPASS',
  uxi: 'UXI',
  sse: 'SSE',
};

function demoPulls(): Map<PlaneId, PlanePull> {
  return new Map(
    PLANE_IDS.map((plane) => {
      const label = DEVICE_PLANE[plane];
      const devices = DEVICES.filter((device) => device.plane === label);
      const siteIds = new Set(devices.map((device) => device.siteId));
      const sites = SITES.filter(
        (site) => siteIds.has(site.id) || site.planes.some((badge) => badge.name === label),
      );
      return [plane, { devices, sites }] as const;
    }),
  );
}

function inventoryPulls(): ReadonlyMap<PlaneId, PlanePull> {
  return settings.get().demoMode ? demoPulls() : poller.contributionsByPlane();
}

function nodeId(kind: string, ...parts: string[]): string {
  return [kind, ...parts.map((part) => encodeURIComponent(part))].join(':');
}

function nodeParts(id: string): string[] | null {
  try {
    return id.split(':').map((part, index) => (index === 0 ? part : decodeURIComponent(part)));
  } catch {
    return null;
  }
}

function asPlane(value: string | undefined): PlaneId | null {
  return value && (PLANE_IDS as readonly string[]).includes(value) ? (value as PlaneId) : null;
}

function limitFrom(req: Request): number | null {
  if (req.query.limit === undefined || req.query.limit === '') return DEFAULT_LIMIT;
  if (typeof req.query.limit !== 'string') return null;
  const raw = Number(req.query.limit);
  return Number.isInteger(raw) && raw > 0 ? Math.min(MAX_LIMIT, raw) : null;
}

function cursorFrom(req: Request): number | null {
  if (req.query.cursor === undefined || req.query.cursor === '') return 0;
  if (typeof req.query.cursor !== 'string') return null;
  const raw = Number(req.query.cursor);
  return Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function queryFrom(req: Request): string {
  return typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 120) : '';
}

function paginate<T>(rows: T[], offset: number, limit: number): { rows: T[]; nextCursor: string | null } {
  const page = rows.slice(offset, offset + limit);
  return { rows: page, nextCursor: offset + page.length < rows.length ? String(offset + page.length) : null };
}

function matches(node: InventoryTreeNode, query: string): boolean {
  const identity = Object.values(node.identity ?? {})
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return !query || `${node.label} ${node.meta ?? ''} ${identity}`.toLowerCase().includes(query);
}

function deviceMatches(device: DeviceRow, query: string): boolean {
  return (
    !query ||
    [
      device.name,
      device.model,
      device.siteName,
      device.siteId,
      device.plane,
      device.serial,
      device.mac,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query)
  );
}

function stateTone(state: InventoryNodeReadState): Tone {
  if (state === 'current') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'denied' || state === 'unsupported' || state === 'stale') return 'warning';
  return 'neutral';
}

function descendantState(
  plane: PlaneId,
  specific: InventoryNodeReadState = 'current',
): InventoryNodeReadState {
  if (specific === 'denied' || specific === 'unsupported' || specific === 'failed') {
    return specific;
  }
  if (settings.get().demoMode) {
    const row = SYSTEMS.find((system) => system.name === SYSTEM_LABEL[plane]);
    if (!row) return 'unlinked';
    return row.state === 'healthy' ? specific : 'stale';
  }
  const state = registry.state(plane);
  if (!state.linked) return 'unlinked';
  if (state.health === 'degraded') return 'failed';
  if (state.stale) return 'stale';
  return specific;
}

/** True when the plane holds credentials and is actually polled. */
function planeLinked(id: PlaneId): boolean {
  return settings.get().demoMode
    ? SYSTEMS.some((system) => system.name === SYSTEM_LABEL[id])
    : registry.state(id).linked;
}

function planeNode(id: PlaneId, pull: PlanePull | undefined): InventoryTreeNode {
  const parentId = planeLinked(id) ? SYSTEMS_ROOT : DORMANT_ROOT;
  if (settings.get().demoMode) {
    const row = SYSTEMS.find((system) => system.name === SYSTEM_LABEL[id]);
    const childCount =
      new Set([...(pull?.sites ?? []).map((site) => site.id), ...(pull?.devices ?? []).map((device) => device.siteId)]).size +
      (pull?.devices?.length ?? 0);
    if (!row) {
      return {
        id: nodeId('system', id),
        parentId,
        kind: 'system',
        label: SYSTEM_LABEL[id],
        meta: 'not included in the demo fixture',
        status: 'unlinked',
        tone: 'neutral',
        hasChildren: false,
        childCount: 0,
        target: `/systems?plane=${encodeURIComponent(id)}`,
        identity: { plane: id },
      };
    }
    const status: InventoryNodeReadState = row.state === 'healthy' ? 'current' : 'stale';
    return {
      id: nodeId('system', id),
      parentId,
      kind: 'system',
      label: row.name,
      meta: row.kind,
      count: pull?.devices?.length,
      status,
      tone: row.tone,
      hasChildren: childCount > 0,
      childCount,
      target: `/systems?plane=${encodeURIComponent(id)}`,
      identity: { plane: id },
    };
  }
  const state = registry.state(id);
  const childCount =
    id === 'sse'
      ? SSE_OBJECT_KINDS.length
      : new Set([...(pull?.sites ?? []).map((site) => site.id), ...(pull?.devices ?? []).map((device) => device.siteId)]).size +
        (pull?.devices?.length ?? 0);
  const status: InventoryNodeReadState = !state.linked
    ? 'unlinked'
    : state.health === 'degraded'
      ? 'failed'
      : state.stale
        ? 'stale'
        : 'current';
  return {
    id: nodeId('system', id),
    parentId,
    kind: 'system',
    label: SYSTEM_LABEL[id],
    meta: state.note ?? undefined,
    count: id === 'sse' ? state.deviceCount ?? undefined : pull?.devices?.length,
    status,
    tone: stateTone(status),
    hasChildren: state.linked && childCount > 0,
    childCount,
    target: `/systems?plane=${encodeURIComponent(id)}`,
    identity: { plane: id },
  };
}

function siteNodes(plane: PlaneId, pull: PlanePull): InventoryTreeNode[] {
  const sites = new Map<string, SiteRow | { id: string; name: string; devices: number }>();
  const deviceCounts = new Map<string, number>();
  for (const site of pull.sites ?? []) sites.set(site.id, site);
  for (const device of pull.devices ?? []) {
    deviceCounts.set(device.siteId, (deviceCounts.get(device.siteId) ?? 0) + 1);
    if (!sites.has(device.siteId)) sites.set(device.siteId, { id: device.siteId, name: device.siteName, devices: 0 });
  }
  return [...sites.values()]
    .map((site) => {
      const count = deviceCounts.get(site.id) ?? 0;
      const status = descendantState(plane);
      return {
        id: nodeId('site', plane, site.id),
        parentId: nodeId('system-sites', plane),
        kind: 'site' as const,
        label: site.name,
        meta: `${count} device${count === 1 ? '' : 's'}`,
        count,
        status,
        tone: stateTone(status),
        hasChildren: count > 0,
        childCount: count,
        target: `/sites/${encodeURIComponent(site.id)}`,
        identity: { plane, siteId: site.id },
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function deviceNode(device: DeviceRow, parentId: string, plane: PlaneId): InventoryTreeNode {
  const params = new URLSearchParams();
  params.set('plane', device.plane);
  if (device.serial) params.set('serial', device.serial);
  const status = descendantState(plane, device.state === 'unverified' ? 'stale' : 'current');
  const identityKey = device.serial ?? device.mac ?? device.name;
  const siteOccurrence = parentId.startsWith('site:');
  return {
    id: siteOccurrence
      ? nodeId('site-device', plane, device.siteId, identityKey)
      : nodeId('device', plane, identityKey),
    parentId,
    kind: device.type === 'switch' ? 'switch' : 'device',
    label: device.name,
    meta: `${device.model} · ${device.siteName}`,
    status,
    tone: stateTone(status),
    hasChildren: false,
    target: `/devices/${encodeURIComponent(device.name)}?${params.toString()}`,
    identity: { plane: device.plane, serial: device.serial, siteId: device.siteId },
  };
}

function sseReadState(status: SseKindReadStatus | undefined): InventoryNodeReadState {
  if (!status || status.state === 'ok') return 'current';
  if (status.reason === 'denied') return 'denied';
  if (status.reason === 'unsupported') return 'unsupported';
  return 'failed';
}

function sseKindNodes(pull: PlanePull): InventoryTreeNode[] {
  const inventory = pull.sse;
  if (!inventory) return [];
  return SSE_OBJECT_KINDS.map((kind) => {
    const result = inventory.kinds[kind];
    const status = descendantState('sse', sseReadState(inventory.readStatus?.[kind]));
    const count = result?.total ?? result?.rows.length;
    return {
      id: nodeId('sse-kind', kind),
      parentId: nodeId('system', 'sse'),
      kind: 'sse-kind',
      label: SSE_OBJECT_KIND_LABELS[kind],
      meta:
        status === 'current'
          ? `${count ?? 0} object${count === 1 ? '' : 's'}`
          : inventory.readStatus?.[kind]?.state === 'failed'
            ? inventory.readStatus[kind]!.message
            : undefined,
      count: count ?? undefined,
      status,
      tone: stateTone(status),
      hasChildren: (result?.rows.length ?? 0) > 0,
      childCount: result?.total ?? result?.rows.length ?? 0,
      target: `/inventory?node=${encodeURIComponent(nodeId('sse-kind', kind))}`,
      identity: { plane: 'sse', sseKind: kind },
    } satisfies InventoryTreeNode;
  });
}

function sseObjectMatches(
  row: NonNullable<NonNullable<PlanePull['sse']>['kinds'][SseObjectKind]>['rows'][number],
  query: string,
): boolean {
  return (
    !query ||
    [row.name, row.id, row.detail, row.description, row.kind]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query)
  );
}

function sseObjectNode(
  kind: SseObjectKind,
  row: NonNullable<NonNullable<PlanePull['sse']>['kinds'][SseObjectKind]>['rows'][number],
): InventoryTreeNode {
  const status = descendantState('sse');
  return {
    id: nodeId('sse-object', kind, row.id),
    parentId: nodeId('sse-kind', kind),
    kind: 'sse-object',
    label: row.name,
    meta: row.detail ?? row.description,
    status,
    tone: status === 'current' && row.enabled !== false ? 'success' : stateTone(status),
    hasChildren: false,
    target: `/inventory?node=${encodeURIComponent(nodeId('sse-object', kind, row.id))}`,
    identity: { plane: 'sse', sseKind: kind, objectId: row.id },
  };
}

function sseObjectNodes(kind: SseObjectKind, pull: PlanePull, query = ''): InventoryTreeNode[] {
  const result = pull.sse?.kinds[kind];
  if (!result) return [];
  return result.rows.filter((row) => sseObjectMatches(row, query)).map((row) => sseObjectNode(kind, row));
}

function dormantNode(count: number): InventoryTreeNode {
  return {
    id: DORMANT_ROOT,
    parentId: SYSTEMS_ROOT,
    kind: 'group',
    label: 'Not linked',
    meta: 'no credentials stored — nothing is polled',
    count,
    status: 'unlinked',
    tone: 'neutral',
    hasChildren: count > 0,
    childCount: count,
    target: '/systems',
  };
}

function childrenFor(parentId: string | null): InventoryTreeNode[] | null {
  const demoMode = settings.get().demoMode;
  const pulls = inventoryPulls();
  if (parentId === null) {
    return [
      {
        id: SYSTEMS_ROOT,
        parentId: null,
        kind: 'group',
        label: 'Connected systems',
        meta: `${
          demoMode
            ? PLANE_IDS.filter((id) => SYSTEMS.some((system) => system.name === SYSTEM_LABEL[id])).length
            : PLANE_IDS.filter((id) => registry.state(id).linked).length
        } of ${PLANE_IDS.length} linked`,
        status: 'current',
        tone: 'neutral',
        hasChildren: true,
        childCount: PLANE_IDS.length,
        target: '/systems',
      },
    ];
  }
  if (parentId === SYSTEMS_ROOT) {
    const linked = PLANE_IDS.filter((id) => planeLinked(id));
    const dormant = PLANE_IDS.filter((id) => !planeLinked(id));
    const nodes = linked.map((id) => planeNode(id, pulls.get(id)));
    if (dormant.length > 0) nodes.push(dormantNode(dormant.length));
    return nodes;
  }
  if (parentId === DORMANT_ROOT) {
    return PLANE_IDS.filter((id) => !planeLinked(id)).map((id) => planeNode(id, pulls.get(id)));
  }

  const parts = nodeParts(parentId);
  if (!parts) return null;
  const [kind, first, second, ...extra] = parts;
  if (extra.length > 0) return null;
  if (kind === 'system') {
    const plane = asPlane(first);
    const linked = plane
      ? demoMode
        ? SYSTEMS.some((system) => system.name === SYSTEM_LABEL[plane])
        : registry.state(plane).linked
      : false;
    if (!plane || !linked) return [];
    const pull = pulls.get(plane);
    if (!pull) return [];
    if (plane === 'sse') return sseKindNodes(pull);
    const siteCount = siteNodes(plane, pull).length;
    const deviceCount = pull.devices?.length ?? 0;
    const status = descendantState(plane);
    return [
      {
        id: nodeId('system-sites', plane),
        parentId,
        kind: 'device-group',
        label: 'Sites',
        count: siteCount,
        status,
        tone: stateTone(status),
        hasChildren: siteCount > 0,
        childCount: siteCount,
        target: '/sites',
      },
      {
        id: nodeId('system-devices', plane),
        parentId,
        kind: 'device-group',
        label: 'Devices',
        count: deviceCount,
        status,
        tone: stateTone(status),
        hasChildren: deviceCount > 0,
        childCount: deviceCount,
        target: `/devices?plane=${encodeURIComponent(plane)}`,
      },
    ];
  }
  if (kind === 'system-sites') {
    const plane = asPlane(first);
    const pull = plane ? pulls.get(plane) : undefined;
    return plane && pull ? siteNodes(plane, pull) : [];
  }
  if (kind === 'system-devices') {
    const plane = asPlane(first);
    const pull = plane ? pulls.get(plane) : undefined;
    return plane && pull ? (pull.devices ?? []).map((device) => deviceNode(device, parentId, plane)) : [];
  }
  if (kind === 'site') {
    const plane = asPlane(first);
    const pull = plane ? pulls.get(plane) : undefined;
    return plane && pull
      ? (pull.devices ?? [])
          .filter((device) => device.siteId === second)
          .map((device) => deviceNode(device, parentId, plane))
      : [];
  }
  if (kind === 'sse-kind' && (SSE_OBJECT_KINDS as readonly string[]).includes(first)) {
    const pull = pulls.get('sse');
    return pull ? sseObjectNodes(first as SseObjectKind, pull) : [];
  }
  return null;
}

function pagedChildrenFor(
  parentId: string | null,
  query: string,
  offset: number,
  limit: number,
): { nodes: InventoryTreeNode[]; total: number; nextCursor: string | null } | null {
  if (parentId) {
    const parts = nodeParts(parentId);
    if (!parts) return null;
    const [kind, first, second, ...extra] = parts;
    if (extra.length > 0) return null;
    if (kind === 'system-devices' || kind === 'site') {
      const plane = asPlane(first);
      const pull = plane ? inventoryPulls().get(plane) : undefined;
      if (!plane || !pull) return { nodes: [], total: 0, nextCursor: null };
      const devices = (pull.devices ?? []).filter(
        (device) => (kind !== 'site' || device.siteId === second) && deviceMatches(device, query),
      );
      const page = devices.slice(offset, offset + limit);
      return {
        nodes: page.map((device) => deviceNode(device, parentId, plane)),
        total: devices.length,
        nextCursor: offset + page.length < devices.length ? String(offset + page.length) : null,
      };
    }
    if (kind === 'sse-kind' && (SSE_OBJECT_KINDS as readonly string[]).includes(first)) {
      const pull = inventoryPulls().get('sse');
      if (!pull) return { nodes: [], total: 0, nextCursor: null };
      const objectKind = first as SseObjectKind;
      const rows = (pull.sse?.kinds[objectKind]?.rows ?? []).filter((row) => sseObjectMatches(row, query));
      const page = rows.slice(offset, offset + limit);
      return {
        nodes: page.map((row) => sseObjectNode(objectKind, row)),
        total: rows.length,
        nextCursor: offset + page.length < rows.length ? String(offset + page.length) : null,
      };
    }
  }
  const children = childrenFor(parentId);
  if (children === null) return null;
  const rows = children.filter((node) => matches(node, query));
  const { rows: nodes, nextCursor } = paginate(rows, offset, limit);
  return { nodes, total: rows.length, nextCursor };
}

function allSearchNodes(query = ''): InventoryTreeNode[] {
  const pulls = inventoryPulls();
  const nodes: InventoryTreeNode[] = [];
  const add = (candidates: InventoryTreeNode[]) => {
    nodes.push(...candidates.filter((node) => matches(node, query)));
  };
  add(childrenFor(null) ?? []);
  add(PLANE_IDS.map((id) => planeNode(id, pulls.get(id))));
  for (const [plane, pull] of pulls) {
    if (plane === 'sse') {
      add(sseKindNodes(pull));
      for (const kind of SSE_OBJECT_KINDS) add(sseObjectNodes(kind, pull, query));
      continue;
    }
    add(siteNodes(plane, pull));
    nodes.push(
      ...(pull.devices ?? [])
        .filter((device) => deviceMatches(device, query))
        .map((device) => deviceNode(device, nodeId('system-devices', plane), plane)),
    );
  }
  return nodes;
}

function exactNode(id: string): InventoryTreeNode | null {
  if (id === SYSTEMS_ROOT) return childrenFor(null)?.[0] ?? null;
  if (id === DORMANT_ROOT) {
    const dormant = PLANE_IDS.filter((plane) => !planeLinked(plane)).length;
    return dormant > 0 ? dormantNode(dormant) : null;
  }
  const parts = nodeParts(id);
  if (!parts) return null;
  const [kind, first, second, third, ...extra] = parts;
  if (extra.length > 0) return null;
  if (kind === 'system') {
    const plane = asPlane(first);
    return plane ? planeNode(plane, inventoryPulls().get(plane)) : null;
  }
  if (kind === 'system-sites' || kind === 'system-devices') {
    const plane = asPlane(first);
    return plane
      ? (childrenFor(nodeId('system', plane)) ?? []).find((node) => node.id === id) ?? null
      : null;
  }
  if (kind === 'site') {
    const plane = asPlane(first);
    const pull = plane ? inventoryPulls().get(plane) : undefined;
    return plane && pull ? siteNodes(plane, pull).find((node) => node.id === id) ?? null : null;
  }
  if (kind === 'device') {
    const plane = asPlane(first);
    const pull = plane ? inventoryPulls().get(plane) : undefined;
    const device = pull?.devices?.find((row) => (row.serial ?? row.mac ?? row.name) === second);
    return plane && device ? deviceNode(device, nodeId('system-devices', plane), plane) : null;
  }
  if (kind === 'site-device') {
    const plane = asPlane(first);
    const pull = plane ? inventoryPulls().get(plane) : undefined;
    const device = pull?.devices?.find(
      (row) => row.siteId === second && (row.serial ?? row.mac ?? row.name) === third,
    );
    return plane && device ? deviceNode(device, nodeId('site', plane, second), plane) : null;
  }
  if (kind === 'sse-kind' && (SSE_OBJECT_KINDS as readonly string[]).includes(first)) {
    return sseKindNodes(inventoryPulls().get('sse') ?? {}).find((node) => node.id === id) ?? null;
  }
  if (kind === 'sse-object' && (SSE_OBJECT_KINDS as readonly string[]).includes(first)) {
    const objectKind = first as SseObjectKind;
    const row = inventoryPulls()
      .get('sse')
      ?.sse?.kinds[objectKind]?.rows.find((candidate) => candidate.id === second);
    return row ? sseObjectNode(objectKind, row) : null;
  }
  return null;
}

inventoryRouter.get('/inventory/tree', (req, res) => {
  const parentId = typeof req.query.parent === 'string' && req.query.parent !== '' ? req.query.parent : null;
  const query = queryFrom(req);
  const limit = limitFrom(req);
  const cursor = cursorFrom(req);
  if (limit === null || cursor === null) {
    res.status(400).json({ error: 'limit must be a positive integer and cursor must be a non-negative integer' });
    return;
  }
  const page = pagedChildrenFor(parentId, query, cursor, limit);
  if (page === null) {
    res.status(400).json({ error: 'invalid inventory parent id' });
    return;
  }
  const body: InventoryTreePage = { parentId, ...page, query };
  res.json(body);
});

inventoryRouter.get('/inventory/search', (req, res) => {
  const query = queryFrom(req);
  const limit = limitFrom(req);
  const cursor = cursorFrom(req);
  if (limit === null || cursor === null) {
    res.status(400).json({ error: 'limit must be a positive integer and cursor must be a non-negative integer' });
    return;
  }
  const rows = allSearchNodes(query);
  const { rows: nodes, nextCursor } = paginate(rows, cursor, limit);
  const body: InventorySearchPage = { nodes, total: rows.length, nextCursor, query };
  res.json(body);
});

inventoryRouter.get('/inventory/node', (req, res) => {
  if (typeof req.query.id !== 'string' || req.query.id.length === 0 || req.query.id.length > 500) {
    res.status(400).json({ error: 'inventory node id is required' });
    return;
  }
  const node = exactNode(req.query.id);
  if (!node) {
    res.status(404).json({ error: 'inventory node not found' });
    return;
  }
  res.json(node);
});
