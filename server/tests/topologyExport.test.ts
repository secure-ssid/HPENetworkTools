/**
 * GET /api/topology + /api/topology/export — reported graph facts CSV.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-topology-export-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const { createApp } = await import('../src/index');
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

describe('topology export', () => {
  it('GET /api/topology returns a graph envelope', async () => {
    const r = await fetch(`${base}/api/topology`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      graph: { nodes: unknown[]; edges: unknown[] };
      notes: string[];
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.graph.nodes)).toBe(true);
    expect(Array.isArray(body.graph.edges)).toBe(true);
    expect(Array.isArray(body.notes)).toBe(true);
  });

  it('GET /api/topology/export defaults to nodes CSV without secrets', async () => {
    const r = await fetch(`${base}/api/topology/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('id');
    expect(header).toContain('name');
    expect(header).toContain('type');
    expect(header).toContain('siteId');
    expect(header).toContain('serial');
    expect(header).toContain('ghost');
    expect(header).toContain('planes');
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/topology/export?part=edges returns edge facts CSV', async () => {
    const r = await fetch(`${base}/api/topology/export?part=edges`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('from');
    expect(header).toContain('to');
    expect(header).toContain('crossSite');
    expect(header).toContain('stale');
    expect(header).toContain('protocols');
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/topology/export rejects unknown part', async () => {
    const r = await fetch(`${base}/api/topology/export?part=guessed`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: string };
    expect(body.error ?? '').toMatch(/part/i);
  });

  it('GET /api/topology/export honours q/plane/ghosts filters (Loop 80)', async () => {
    const full = await fetch(`${base}/api/topology/export?part=nodes`);
    expect(full.status).toBe(200);
    const fullText = await full.text();
    const fullRows = fullText.trim().split('\n').filter(Boolean).length - 1;

    const q = await fetch(`${base}/api/topology/export?part=nodes&q=Campus-01`);
    expect(q.status).toBe(200);
    const qText = await q.text();
    const qRows = qText.trim().split('\n').filter(Boolean).length - 1;
    expect(qRows).toBeGreaterThanOrEqual(0);
    expect(qRows).toBeLessThanOrEqual(fullRows);
    // Filtered rows should mention Campus-01 when any nodes match.
    if (qRows > 0) expect(qText.toLowerCase()).toMatch(/campus-01/);

    const ghosts = await fetch(`${base}/api/topology/export?part=nodes&ghosts=1`);
    expect(ghosts.status).toBe(200);
    const ghostText = await ghosts.text();
    const ghostLines = ghostText.trim().split('\n').slice(1).filter(Boolean);
    for (const line of ghostLines) {
      // ghost column is yes/no near the end of NODE_HEADER
      expect(line).toMatch(/,yes(,|$)/i);
    }

    // Loop 115/116: queryFlag accepts yes/on as ghosts-only aliases of 1/true.
    const ghostsYes = await fetch(`${base}/api/topology/export?part=nodes&ghosts=yes`);
    expect(ghostsYes.status).toBe(200);
    expect((await ghostsYes.text()).trim()).toBe(ghostText.trim());
    const ghostsOn = await fetch(`${base}/api/topology/export?part=nodes&ghosts=on`);
    expect(ghostsOn.status).toBe(200);
    expect((await ghostsOn.text()).trim()).toBe(ghostText.trim());

    const edges = await fetch(`${base}/api/topology/export?part=edges&q=Campus-01`);
    expect(edges.status).toBe(200);
    expect(edges.headers.get('content-type') ?? '').toMatch(/text\/csv/);
  });

  it('GET /api/topology/export honours exact type= filter (Loop 104)', async () => {
    const full = await fetch(`${base}/api/topology/export?part=nodes`);
    expect(full.status).toBe(200);
    const fullText = await full.text();
    const fullLines = fullText.trim().split('\n').filter(Boolean);
    const header = (fullLines[0] ?? '').split(',');
    const typeIdx = header.indexOf('type');
    expect(typeIdx).toBeGreaterThanOrEqual(0);

    // Pick a type that appears in the demo/live graph when any typed nodes exist.
    const types = new Set(
      fullLines.slice(1).map((line) => {
        // Minimal CSV split is enough for fixture rows (no quoted commas in type).
        const cols = line.split(',');
        return (cols[typeIdx] ?? '').trim().toLowerCase();
      }).filter(Boolean),
    );
    if (types.size === 0) return;
    const sampleType = [...types][0]!;
    const filtered = await fetch(
      `${base}/api/topology/export?part=nodes&type=${encodeURIComponent(sampleType)}`,
    );
    expect(filtered.status).toBe(200);
    const fText = await filtered.text();
    const fLines = fText.trim().split('\n').slice(1).filter(Boolean);
    expect(fLines.length).toBeGreaterThan(0);
    expect(fLines.length).toBeLessThanOrEqual(fullLines.length - 1);
    for (const line of fLines) {
      const cols = line.split(',');
      expect((cols[typeIdx] ?? '').trim().toLowerCase()).toBe(sampleType);
    }

    // Unknown type is an honest empty body (header only), not 400.
    const empty = await fetch(`${base}/api/topology/export?part=nodes&type=not-a-device-class`);
    expect(empty.status).toBe(200);
    const emptyLines = (await empty.text()).trim().split('\n').filter(Boolean);
    expect(emptyLines.length).toBe(1);
  });

  it('OpenAPI lists topology export and recent screen paths (Loop 54)', async () => {
    const r = await fetch(`${base}/api/openapi.json`);
    expect(r.status).toBe(200);
    const spec = (await r.json()) as {
      paths: Record<string, { get?: { parameters?: Array<{ name?: string }> } }>;
    };
    expect(spec.paths['/api/topology']).toBeTruthy();
    expect(spec.paths['/api/topology/export']).toBeTruthy();
    expect(spec.paths['/api/central']).toBeTruthy();
    expect(spec.paths['/api/clearpass']).toBeTruthy();
    expect(spec.paths['/api/clearpass/endpoints']).toBeTruthy();
    expect(spec.paths['/api/configure']).toBeTruthy();
    expect(spec.paths['/api/search-index']).toBeTruthy();
    expect(spec.paths['/api/devices/{name}']).toBeTruthy();
    expect(spec.paths['/api/clients/{mac}']).toBeTruthy();
    const siteParams = spec.paths['/api/sites']?.get?.parameters ?? [];
    expect(siteParams.some((p) => p.name === 'q')).toBe(true);
  });
});
