/**
 * GET /api/systems/export — connected-systems roster CSV (Loop 100).
 * Summary fields only; optional health/linked/q filters.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-systems-export-'));
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

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);
  const header = (lines[0] ?? '').split(',');
  const rows = lines.slice(1).map((l) => l.split(','));
  return { header, rows };
}

describe('GET /api/systems/export (Loop 100)', () => {
  it('returns roster CSV without secrets or free-text notes', async () => {
    const r = await fetch(`${base}/api/systems/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const { header, rows } = parseCsv(text);
    expect(header).toEqual([
      'name',
      'planeId',
      'kind',
      'health',
      'linked',
      'scope',
      'lastSync',
      'devices',
      'callsToday',
    ]);
    expect(rows.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/password|secret|token|api[_-]?key|credential/i);
    // Free-text note / event bodies must not appear as columns.
    expect(header).not.toContain('note');
    expect(header).not.toContain('events');
    expect(header).not.toContain('calls');
  });

  it('honours health= and linked= filters', async () => {
    const all = parseCsv(await (await fetch(`${base}/api/systems/export`)).text());
    const healthIdx = all.header.indexOf('health');
    const linkedIdx = all.header.indexOf('linked');
    expect(healthIdx).toBeGreaterThanOrEqual(0);

    const healthy = parseCsv(
      await (await fetch(`${base}/api/systems/export?health=healthy`)).text(),
    );
    for (const row of healthy.rows) {
      expect(row[healthIdx]?.toLowerCase()).toBe('healthy');
    }

    const linked = parseCsv(await (await fetch(`${base}/api/systems/export?linked=1`)).text());
    for (const row of linked.rows) {
      expect(row[linkedIdx]).toBe('true');
    }

    // Unknown health is an honest no-op (full roster), not 400 / empty invent.
    const noop = parseCsv(
      await (await fetch(`${base}/api/systems/export?health=not-a-real-health`)).text(),
    );
    expect(noop.rows.length).toBe(all.rows.length);
  });

  it('applySystemsRosterFilters unit contract (Loop 118 query helpers)', async () => {
    const { applySystemsRosterFilters } = await import('../src/routes/screens/systemsScreen');
    const rows = [
      { name: 'Central', planeId: 'central', kind: 'cloud', state: 'healthy', scope: 'read' },
      { name: 'Mist', planeId: 'mist', kind: 'cloud', state: 'unlinked', scope: 'read only' },
      { name: 'UXI', planeId: 'uxi', kind: 'sensors', state: 'degraded', scope: 'read' },
    ];
    expect(applySystemsRosterFilters({ query: { health: 'healthy' } }, rows)).toEqual([rows[0]]);
    expect(applySystemsRosterFilters({ query: { health: 'HEALTHY' } }, rows)).toEqual([rows[0]]);
    expect(applySystemsRosterFilters({ query: { linked: '0' } }, rows)).toEqual([rows[1]]);
    // Loop 118: queryFlag yes/on/no/off parity for linked.
    expect(applySystemsRosterFilters({ query: { linked: 'no' } }, rows)).toEqual([rows[1]]);
    expect(applySystemsRosterFilters({ query: { linked: 'off' } }, rows)).toEqual([rows[1]]);
    expect(applySystemsRosterFilters({ query: { linked: 'yes' } }, rows).map((r) => r.planeId)).toEqual([
      'central',
      'uxi',
    ]);
    expect(applySystemsRosterFilters({ query: { linked: 'ON' } }, rows).map((r) => r.planeId)).toEqual([
      'central',
      'uxi',
    ]);
    expect(applySystemsRosterFilters({ query: { q: '  UXI  ' } }, rows)).toEqual([rows[2]]);
    // Unknown health remains an honest no-op.
    expect(applySystemsRosterFilters({ query: { health: 'not-real' } }, rows)).toHaveLength(3);
  });
});
