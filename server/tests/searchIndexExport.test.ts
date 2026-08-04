/**
 * GET /api/search-index/export — jump-index CSV (Loop 102).
 * Loop 122: applySearchIndexFilters shared queryString honesty.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import type { SearchIndexEntry } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let applySearchIndexFilters: typeof import('../src/routes/screens/searchScreen').applySearchIndexFilters;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-search-export-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  // Import only after env is set so settings/poller singletons bind to temp paths.
  const { createApp } = await import('../src/index');
  ({ applySearchIndexFilters } = await import('../src/routes/screens/searchScreen'));
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

describe('applySearchIndexFilters (Loop 122 queryString)', () => {
  const entries: SearchIndexEntry[] = [
    { kind: 'device', label: 'sw-core-1', meta: 'CENTRAL', view: 'devices', arg: 'SN1' },
    { kind: 'site', label: 'Branch HQ', meta: 'MIST', view: 'sites', arg: 'site-1' },
    { kind: 'device', label: 'ap-lobby', meta: 'MIST', view: 'devices', arg: 'SN2' },
  ];

  it('narrows by q= and kind= and ignores non-string bags', () => {
    const byKind = applySearchIndexFilters(
      { query: { kind: 'DEVICE' } } as unknown as Request,
      entries,
    );
    expect(byKind.map((e) => e.label)).toEqual(['sw-core-1', 'ap-lobby']);

    const byQ = applySearchIndexFilters(
      { query: { q: '  branch  ' } } as unknown as Request,
      entries,
    );
    expect(byQ.map((e) => e.label)).toEqual(['Branch HQ']);

    const arrayKind = applySearchIndexFilters(
      { query: { kind: ['device'] } } as unknown as Request,
      entries,
    );
    expect(arrayKind).toHaveLength(entries.length);

    const unknownKind = applySearchIndexFilters(
      { query: { kind: 'nope' } } as unknown as Request,
      entries,
    );
    // Unknown kind → honest empty, never invents hits.
    expect(unknownKind).toEqual([]);
  });
});

describe('search-index export', () => {
  it('GET /api/search-index/export returns kind/label/meta/view/arg CSV', async () => {
    const r = await fetch(`${base}/api/search-index/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    expect(text.split('\n')[0]).toBe('kind,label,meta,view,arg');
    expect(text.trim().split('\n').length).toBeGreaterThan(1);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('honours optional q= and kind= filters', async () => {
    const full = await fetch(`${base}/api/search-index/export`);
    expect(full.status).toBe(200);
    const fullRows = (await full.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(fullRows.length).toBeGreaterThan(0);

    const kind = await fetch(`${base}/api/search-index/export?kind=device`);
    expect(kind.status).toBe(200);
    const kindRows = (await kind.text()).trim().split('\n').slice(1).filter(Boolean);
    for (const line of kindRows) {
      expect(line.toLowerCase().startsWith('device,')).toBe(true);
    }

    const miss = await fetch(`${base}/api/search-index/export?q=zzz-no-such-search-hit`);
    expect(miss.status).toBe(200);
    const missBody = (await miss.text()).trim();
    // Header only — honest empty filter, not an error.
    expect(missBody.split('\n').filter(Boolean)).toEqual(['kind,label,meta,view,arg']);
  });

  it('GET /api/search-index still returns the JSON envelope', async () => {
    const r = await fetch(`${base}/api/search-index`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });
});
