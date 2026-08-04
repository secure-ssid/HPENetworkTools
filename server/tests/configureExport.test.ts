/**
 * GET /api/configure/export — Configure inventory summary CSV (Loop 95).
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-configure-export-'));
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

describe('configure inventory export (Loop 95)', () => {
  it('GET /api/configure/export defaults to ssids CSV without secrets', async () => {
    const r = await fetch(`${base}/api/configure/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('name');
    expect(header).toContain('vlan');
    expect(header).toContain('security');
    expect(header).toContain('note');
    expect(header).not.toMatch(/password|secret|token|psk|apiKey|credential/i);
    const lines = text.trim().split('\n').slice(1).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('GET /api/configure/export?part=ports|vlans returns inventory slices', async () => {
    const ports = await fetch(`${base}/api/configure/export?part=ports`);
    expect(ports.status).toBe(200);
    const portsText = await ports.text();
    expect(portsText.split('\n')[0]).toMatch(/device/);
    expect(portsText.split('\n')[0]).toMatch(/port/);

    const vlans = await fetch(`${base}/api/configure/export?part=vlans`);
    expect(vlans.status).toBe(200);
    const vlansText = await vlans.text();
    expect(vlansText.split('\n')[0]).toMatch(/id/);
    expect(vlansText.split('\n')[0]).toMatch(/role/);
  });

  it('GET /api/configure/export rejects unknown part', async () => {
    const r = await fetch(`${base}/api/configure/export?part=passwords`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: string };
    expect(body.error ?? '').toMatch(/part/i);
  });

  it('GET /api/configure/export?q= filters ssid rows', async () => {
    const all = await fetch(`${base}/api/configure/export?part=ssids`);
    expect(all.status).toBe(200);
    const allLines = (await all.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(allLines.length).toBeGreaterThan(0);

    const miss = await fetch(`${base}/api/configure/export?part=ssids&q=__no_such_ssid__`);
    expect(miss.status).toBe(200);
    const missLines = (await miss.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(missLines).toHaveLength(0);

    if (allLines.length > 0) {
      const sample = allLines[0]!.split(',')[0]?.replace(/^"|"$/g, '') ?? '';
      if (sample.length >= 2) {
        const hit = await fetch(
          `${base}/api/configure/export?part=ssids&q=${encodeURIComponent(sample.slice(0, 3))}`,
        );
        expect(hit.status).toBe(200);
        const hitLines = (await hit.text()).trim().split('\n').slice(1).filter(Boolean);
        expect(hitLines.length).toBeGreaterThan(0);
        expect(hitLines.length).toBeLessThanOrEqual(allLines.length);
      }
    }
  });

  it('OpenAPI documents configure export part enum', async () => {
    const r = await fetch(`${base}/api/openapi.json`);
    expect(r.status).toBe(200);
    const spec = (await r.json()) as {
      paths: Record<string, { get?: { parameters?: Array<{ name: string; schema?: { enum?: string[] } }> } }>;
    };
    expect(spec.paths['/api/configure/export']).toBeTruthy();
    const params = spec.paths['/api/configure/export']?.get?.parameters ?? [];
    const part = params.find((p) => p.name === 'part');
    expect(part?.schema?.enum).toEqual(expect.arrayContaining(['ssids', 'ports', 'vlans']));
    expect(params.some((p) => p.name === 'q')).toBe(true);
  });

  it('trims part/q via shared queryString + singular aliases (Loop 121)', async () => {
    const { parseConfigureExportPart, filterConfigureExportRows } = await import(
      '../src/routes/screens/configureScreen'
    );
    expect(parseConfigureExportPart({ query: { part: '  ports  ' } } as never)).toBe('ports');
    expect(parseConfigureExportPart({ query: { part: 'ssid' } } as never)).toBe('ssids');
    expect(parseConfigureExportPart({ query: {} } as never)).toBe('ssids');
    // Non-string → default ssids (honest no-op, not 400).
    expect(parseConfigureExportPart({ query: { part: ['vlans'] } } as never)).toBe('ssids');
    expect(parseConfigureExportPart({ query: { part: 'passwords' } } as never)).toBeNull();

    const rows = filterConfigureExportRows(
      [{ name: 'Corp-WiFi', vlan: '10' }, { name: 'Guest', vlan: '20' }],
      '  corp  ',
      ['name', 'vlan'],
    );
    expect(rows.map((r) => r.name)).toEqual(['Corp-WiFi']);

    const http = await fetch(
      `${base}/api/configure/export?part=${encodeURIComponent('  vlans  ')}&q=${encodeURIComponent('  ')}`,
    );
    expect(http.status).toBe(200);
    expect((await http.text()).split('\n')[0]).toMatch(/id/);
  });
});
