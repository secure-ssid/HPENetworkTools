/**
 * server/tests/inventory.test.ts — the inventory tree and search routes.
 *
 * HPE_SETTINGS_PATH points at a tmp dir so nothing here can touch the real
 * data/settings.json; it must be set before the route module is imported,
 * because the settings singleton resolves its path at construction.
 *
 * The router is mounted on a bare express app rather than the whole portal:
 * these routes read only the poller's contributions and the registry's plane
 * state, and both are stubbed per test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InventorySearchPage, InventoryTreeNode, InventoryTreePage } from '@hpe/shared';
import type { DeviceRow, SiteRow } from '@hpe/shared';
import type { PlaneId, PlanePull } from '../src/planes/types';
import type { PlaneStateView } from '../src/planes/registry';

const tmpDir = mkdtempSync(join(tmpdir(), 'hpe-inventory-'));
process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
process.env.HPE_DATA_DIR = join(tmpDir, 'data');

let app: import('express').Express;
let poller: typeof import('../src/services/poller').poller;
let registry: typeof import('../src/planes/registry').registry;
let settings: typeof import('../src/config/settings').settings;

beforeAll(async () => {
  const express = (await import('express')).default;
  const { inventoryRouter } = await import('../src/routes/inventory');
  ({ poller } = await import('../src/services/poller'));
  ({ registry } = await import('../src/planes/registry'));
  ({ settings } = await import('../src/config/settings'));
  app = express();
  app.use('/api', inventoryRouter);
  settings.update({ demoMode: false });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function planeState(id: PlaneId, over: Partial<PlaneStateView> = {}): PlaneStateView {
  return {
    id,
    linked: false,
    health: 'healthy',
    lastSync: '2024-05-01T12:00:00.000Z',
    deviceCount: null,
    callsToday: 0,
    note: null,
    stale: false,
    ageSec: 30,
    reason: null,
    ...over,
  };
}

/** Link exactly the named planes; everything else reads as unlinked. */
function stubEstate(linked: PlaneId[], pulls: Array<[PlaneId, PlanePull]>): void {
  vi.spyOn(registry, 'state').mockImplementation((id: PlaneId) =>
    planeState(id, linked.includes(id) ? { linked: true } : {}),
  );
  vi.spyOn(poller, 'contributionsByPlane').mockReturnValue(new Map(pulls));
}

function device(over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    name: 'ap-01',
    plane: 'CENTRAL',
    model: 'AP-635',
    serial: 'SN-1',
    mac: 'aa:bb:cc:00:00:01',
    siteId: 'site-a',
    siteName: 'Campus A',
    status: 'up',
    type: 'ap',
    ...over,
  } as DeviceRow;
}

function site(over: Partial<SiteRow> = {}): SiteRow {
  return { id: 'site-a', name: 'Campus A', devices: 1, planes: [], ...over } as SiteRow;
}

/** Express handlers are sync here, so a fake req/res round trip is enough. */
async function get(path: string): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const groups = (body: InventoryTreePage): Record<string, InventoryTreeNode> =>
  Object.fromEntries(body.nodes.map((node) => [node.label, node]));

describe('inventory tree — a dataset that was not read is not a dataset holding nothing', () => {
  it('reports a real read with its count and the plane state', async () => {
    stubEstate(['central'], [['central', { devices: [device()], sites: [site()] }]]);
    const { status, body } = await get('/api/inventory/tree?parent=system%3Acentral');
    expect(status).toBe(200);
    const byLabel = groups(body);
    expect(byLabel.Devices.count).toBe(1);
    expect(byLabel.Devices.status).toBe('current');
    expect(byLabel.Sites.count).toBe(1);
    expect(byLabel.Sites.status).toBe('current');
  });

  /* The defect. Central omits a section it could not read and names it in
   * `partial`; the tree answered `?? 0` and stamped it with the plane's state,
   * so a 404 on every sites endpoint rendered as "Sites 0" with no badge. */
  it('omits the count and drops the green when the pull says it could not read the dataset', async () => {
    stubEstate(['central'], [['central', { devices: [device({ siteId: 'campus-02', siteName: 'Campus B' })], partial: ['sites'] }]]);
    const { body } = await get('/api/inventory/tree?parent=system%3Acentral');
    const sites = groups(body).Sites;
    expect(sites.count).toBeUndefined();
    expect(sites.status).toBe('failed');
    expect(sites.tone).toBe('danger');
    expect(sites.meta).toMatch(/not an empty list/);
  });

  it('keeps a truncated count but says it is a floor', async () => {
    stubEstate(['central'], [['central', { devices: [device(), device({ serial: 'SN-2' })], sites: [site()], partial: ['devices'] }]]);
    const { body } = await get('/api/inventory/tree?parent=system%3Acentral');
    const devices = groups(body).Devices;
    // The rows are real, so the number stays — it is the total that is unknown.
    expect(devices.count).toBe(2);
    expect(devices.status).toBe('failed');
    expect(devices.meta).toMatch(/at least 2, the total is unknown/);
    expect(devices.hasChildren).toBe(true);
  });

  it('does not call an absent dataset zero even when nothing failed', async () => {
    stubEstate(['central'], [['central', { devices: [device()] }]]);
    const { body } = await get('/api/inventory/tree?parent=system%3Acentral');
    const sites = groups(body).Sites;
    expect(sites.count).toBeUndefined();
    expect(sites.status).toBe('unsupported');
    expect(sites.meta).toMatch(/not contributed by this plane/);
    // The devices beside it were read, and keep their honest zero-or-more.
    expect(groups(body).Devices.count).toBe(1);
  });

  it('still reports a genuine empty read as a green zero', async () => {
    stubEstate(['central'], [['central', { devices: [], sites: [] }]]);
    const { body } = await get('/api/inventory/tree?parent=system%3Acentral');
    const byLabel = groups(body);
    // Read, and the answer was nothing. That is not a gap and must not warn.
    expect(byLabel.Devices.count).toBe(0);
    expect(byLabel.Devices.status).toBe('current');
    expect(byLabel.Devices.tone).toBe('success');
    expect(byLabel.Sites.count).toBe(0);
    expect(byLabel.Sites.status).toBe('current');
  });
});

describe('inventory search — a plane read in part was not searched in full', () => {
  it('names a plane whose paged walk did not finish', async () => {
    stubEstate(['central'], [['central', { devices: [device()], sites: [site()], partial: ['devices'] }]]);
    const { body } = (await get('/api/inventory/search?q=ap-01')) as { body: InventorySearchPage };
    expect(body.unsearchedPlanes).toContain('HPE Aruba Central');
  });

  it('names a plane that could not read its sites even though its devices came back', async () => {
    // The old test was `devices === undefined && sites === undefined`, so one
    // dataset arriving was enough to certify the whole plane as searched.
    stubEstate(['central'], [['central', { devices: [device()], partial: ['sites'] }]]);
    const { body } = (await get('/api/inventory/search?q=nothing-matches')) as { body: InventorySearchPage };
    expect(body.total).toBe(0);
    expect(body.unsearchedPlanes).toContain('HPE Aruba Central');
  });

  it('leaves a fully read plane off the unsearched list', async () => {
    stubEstate(['central'], [['central', { devices: [device()], sites: [site()] }]]);
    const { body } = (await get('/api/inventory/search?q=ap-01')) as { body: InventorySearchPage };
    expect(body.unsearchedPlanes).toEqual([]);
    expect(body.total).toBeGreaterThan(0);
  });

  it('names SSE when its object inventory could not be read', async () => {
    stubEstate(['sse'], [['sse', { partial: ['sse'], sse: { kinds: {}, unavailable: [] } as never }]]);
    const { body } = (await get('/api/inventory/search?q=zone')) as { body: InventorySearchPage };
    expect(body.unsearchedPlanes).toContain('HPE Aruba Networking SSE');
  });
});

describe('inventory routes — request bounds', () => {
  it('rejects a non-integer limit and a negative cursor rather than silently defaulting', async () => {
    stubEstate([], []);
    expect((await get('/api/inventory/tree?limit=abc')).status).toBe(400);
    expect((await get('/api/inventory/search?cursor=-1')).status).toBe(400);
  });

  it('answers 404 for a node id that decodes to nothing', async () => {
    stubEstate(['central'], [['central', { devices: [device()] }]]);
    expect((await get('/api/inventory/node?id=device%3Acentral%3Ano-such-serial')).status).toBe(404);
    expect((await get('/api/inventory/node?id=')).status).toBe(400);
  });
});

/* A cursor is only ever issued when the list had strictly more rows to give,
 * so a request that lands at or past the end is not a client paging too far —
 * it is the list having shrunk between two reads. The inventory is a live
 * cache, so that is an ordinary Tuesday, and on the wire it is byte-identical
 * to the last page: no rows, no next cursor. */
describe('inventory paging — a page that vanished is not the end of the list', () => {
  const many = (n: number): DeviceRow[] =>
    Array.from({ length: n }, (_, i) => device({ serial: `SN-${i}`, name: `ap-${i}`, mac: `aa:bb:cc:00:00:${i}` }));

  it('calls a cursor inside the list ok and offers the next one', async () => {
    stubEstate(['central'], [['central', { devices: many(10), sites: [site()] }]]);
    const { body } = await get('/api/inventory/tree?parent=system-devices%3Acentral&limit=4&cursor=0');
    expect(body.nodes).toHaveLength(4);
    expect(body.nextCursor).toBe('4');
    expect(body.cursorState).toBe('ok');
  });

  it('calls the genuine last page ok, not past-end', async () => {
    stubEstate(['central'], [['central', { devices: many(10), sites: [site()] }]]);
    const { body } = await get('/api/inventory/tree?parent=system-devices%3Acentral&limit=4&cursor=8');
    expect(body.nodes).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
    expect(body.cursorState).toBe('ok');
  });

  it('says past-end when the branch shrank under a half-paged read', async () => {
    // The operator paged to 8 against a 10-device plane; by the time they
    // clicked again the plane holds 5. Before this the answer was an empty
    // page with a null cursor — the same answer as "you have seen them all".
    stubEstate(['central'], [['central', { devices: many(5), sites: [site()] }]]);
    const { body } = await get('/api/inventory/tree?parent=system-devices%3Acentral&limit=4&cursor=8');
    expect(body.nodes).toHaveLength(0);
    expect(body.nextCursor).toBeNull();
    expect(body.cursorState).toBe('past-end');
  });

  it('says past-end when the plane pull is gone entirely, not an empty branch', async () => {
    stubEstate(['central'], []);
    const { body } = await get('/api/inventory/tree?parent=system-devices%3Acentral&limit=4&cursor=8');
    expect(body.nodes).toHaveLength(0);
    expect(body.cursorState).toBe('past-end');
  });

  it('keeps an empty first page as an ordinary empty answer', async () => {
    // Nothing was issued to get here, so this is "no rows matched", which is
    // a real answer and must not be dressed up as a list that moved.
    stubEstate(['central'], [['central', { devices: [], sites: [site()] }]]);
    const { body } = await get('/api/inventory/tree?parent=system-devices%3Acentral&limit=4');
    expect(body.nodes).toHaveLength(0);
    expect(body.cursorState).toBe('ok');
  });

  it('reports past-end on search the same way it does on a branch', async () => {
    stubEstate(['central'], [['central', { devices: many(3), sites: [site()] }]]);
    const inRange = await get('/api/inventory/search?q=ap&limit=2&cursor=0');
    expect((inRange.body as InventorySearchPage).cursorState).toBe('ok');
    const past = await get('/api/inventory/search?q=ap&limit=2&cursor=40');
    expect((past.body as InventorySearchPage).nodes).toHaveLength(0);
    expect((past.body as InventorySearchPage).nextCursor).toBeNull();
    expect((past.body as InventorySearchPage).cursorState).toBe('past-end');
  });

  it('reports past-end on an SSE object branch, which paged itself by hand', async () => {
    stubEstate(
      ['sse'],
      [['sse', { sse: { unavailable: [], kinds: { tunnels: { rows: [], status: 'ok' } } } } as unknown as PlanePull]],
    );
    const { body } = await get('/api/inventory/tree?parent=sse-kind%3Atunnels&limit=5&cursor=25');
    expect(body.nodes).toHaveLength(0);
    expect(body.cursorState).toBe('past-end');
  });
});
