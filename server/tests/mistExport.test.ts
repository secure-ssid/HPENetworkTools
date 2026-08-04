/**
 * GET /api/mist/export — Mist-claimed devices CSV (mistScreen full module).
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-mist-export-'));
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

describe('mist export', () => {
  it('GET /api/mist/export returns CSV without secrets', async () => {
    const r = await fetch(`${base}/api/mist/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('name');
    expect(header).toContain('type');
    expect(header).toContain('model');
    expect(header).toContain('site');
    expect(header).toContain('state');
    expect(header).toContain('firmware');
    expect(header).toContain('serial');
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/mist/export?part=rogues returns rogue BSSID CSV (Loop 87)', async () => {
    const r = await fetch(`${base}/api/mist/export?part=rogues`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('bssid');
    expect(header).toContain('seenOnLan');
    expect(header).toContain('ssid');
    expect(text.split('\n').length).toBeGreaterThan(1);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/mist/export?part=ap-stats returns AP health CSV (Loop 87)', async () => {
    const r = await fetch(`${base}/api/mist/export?part=ap-stats`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('device');
    expect(header).toContain('cpuPct');
    expect(header).toContain('clients');
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/mist/export?part=sle returns per-site SLE headlines (Loop 98)', async () => {
    const r = await fetch(`${base}/api/mist/export?part=sle`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('site');
    expect(header).toContain('siteId');
    expect(header).toContain('overall');
    expect(header).toContain('coverage');
    expect(header).toContain('apHealth');
    expect(text).toMatch(/campus-02|Campus-02/i);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/mist/export?part=wlans returns WLAN inventory without PSKs (Loop 104)', async () => {
    const r = await fetch(`${base}/api/mist/export?part=wlans`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('name');
    expect(header).toContain('vlan');
    expect(header).toContain('security');
    expect(header).toContain('targets');
    expect(header).not.toMatch(/psk|password|secret|passphrase/i);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password\s*[:=]|secret\s*[:=]/i);
    // Cleartext Wi-Fi secrets must never appear even if a note mentions PSK.
    expect(text).not.toMatch(/"psk"\s*:\s*"[^"<][^"]+"/i);
  });

  it('GET /api/mist/export?part=wlans honours q= and enabled= filters (Loop 115)', async () => {
    const full = await fetch(`${base}/api/mist/export?part=wlans`);
    expect(full.status).toBe(200);
    const fullText = await full.text();
    const fullRows = fullText.trim().split('\n').filter(Boolean).length - 1;

    const q = await fetch(`${base}/api/mist/export?part=wlans&q=Research`);
    expect(q.status).toBe(200);
    const qText = await q.text();
    const qRows = qText.trim().split('\n').filter(Boolean).length - 1;
    expect(qRows).toBeGreaterThanOrEqual(0);
    expect(qRows).toBeLessThanOrEqual(fullRows);
    if (qRows > 0) expect(qText.toLowerCase()).toMatch(/research/);

    const { filterMistWlanRows } = await import('../src/routes/screens/mistScreen');
    const sample = [
      { name: 'On-SSID', vlan: 'v1', security: 'wpa3', targets: 'a', plane: 'MIST', enabled: true },
      { name: 'Off-SSID', vlan: 'v2', security: 'wpa2', targets: 'b', plane: 'MIST', enabled: false },
      { name: 'Unknown', vlan: 'v3', security: 'open', targets: 'c', plane: 'MIST' },
    ];
    expect(filterMistWlanRows(sample as never, { enabled: true }).map((w) => w.name)).toEqual([
      'On-SSID',
    ]);
    expect(filterMistWlanRows(sample as never, { enabled: false }).map((w) => w.name)).toEqual([
      'Off-SSID',
    ]);
    expect(filterMistWlanRows(sample as never, { q: 'off' }).map((w) => w.name)).toEqual([
      'Off-SSID',
    ]);
    // Undefined enabled never matches an enabled= filter.
    expect(filterMistWlanRows(sample as never, { enabled: true })).toHaveLength(1);

    const en = await fetch(`${base}/api/mist/export?part=wlans&enabled=yes`);
    expect(en.status).toBe(200);
    const enText = await en.text();
    const enRows = enText.trim().split('\n').filter(Boolean).length - 1;
    expect(enRows).toBeLessThanOrEqual(fullRows);
  });

  it('GET /api/mist/export?part=licenses returns usage tallies only (Loop 104)', async () => {
    const r = await fetch(`${base}/api/mist/export?part=licenses`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('site');
    expect(header).toContain('siteId');
    expect(header).toContain('numDevices');
    expect(header).toContain('numAps');
    expect(header).toContain('services');
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/mist/export rejects unknown part', async () => {
    const r = await fetch(`${base}/api/mist/export?part=wallets`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: string };
    expect(body.error ?? '').toMatch(/part must be/i);
  });

  it('GET /api/mist still returns the dashboard envelope', async () => {
    const r = await fetch(`${base}/api/mist`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dataSource: string; devices: unknown[] };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.devices)).toBe(true);
  });

  it('GET /api/mist/audit-log/export returns CSV without secrets', async () => {
    const r = await fetch(`${base}/api/mist/audit-log/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('id');
    expect(header).toContain('admin');
    expect(header).toContain('message');
    expect(header).toContain('before');
    expect(header).toContain('after');
    expect(text).toMatch(/MRDN-Research|auto_upgrade|ap-3f-14/);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password\s*[:=]|secret\s*[:=]/i);
    // Portal redaction marker may appear; raw PSK material must not.
    expect(text).not.toMatch(/"psk"\s*:\s*"[^"<][^"]+"/i);
  });

  it('OpenAPI lists Mist dashboard, audit JSON, and audit CSV export (Loop 52)', async () => {
    const r = await fetch(`${base}/api/openapi.json`);
    expect(r.status).toBe(200);
    const spec = (await r.json()) as { paths: Record<string, unknown> };
    expect(spec.paths['/api/mist']).toBeTruthy();
    expect(spec.paths['/api/mist/export']).toBeTruthy();
    expect(spec.paths['/api/mist/audit-log/export']).toBeTruthy();
    expect(spec.paths['/api/systems/mist/audit-log']).toBeTruthy();
  });

  it('GET /api/systems/mist/audit-log returns envelope without secrets', async () => {
    const r = await fetch(`${base}/api/systems/mist/audit-log?limit=10`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { auditLog: { entries?: Array<{ message?: string }> } | null };
    expect(body.auditLog === null || typeof body.auditLog === 'object').toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password\s*[:=]/i);
  });
});
