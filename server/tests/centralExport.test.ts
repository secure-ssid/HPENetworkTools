/**
 * GET /api/central/export — Central devices + site summary CSV (export-only centralScreen).
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-central-export-'));
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

describe('central export', () => {
  it('GET /api/central/export returns CSV with device and site sections', async () => {
    const r = await fetch(`${base}/api/central/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('section');
    expect(header).toContain('name');
    expect(header).toContain('serial');
    expect(header).toContain('siteId');
    expect(header).toContain('siteName');
    expect(text).toMatch(/\bdevice\b/);
    expect(text).toMatch(/\bsite\b/);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/central/export?part=device|site narrows sections (Loop 86)', async () => {
    const devices = await fetch(`${base}/api/central/export?part=device`);
    expect(devices.status).toBe(200);
    const dRows = (await devices.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(dRows.length).toBeGreaterThan(0);
    expect(dRows.every((line) => line.startsWith('device,'))).toBe(true);

    const sites = await fetch(`${base}/api/central/export?part=site`);
    expect(sites.status).toBe(200);
    const sRows = (await sites.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(sRows.length).toBeGreaterThan(0);
    expect(sRows.every((line) => line.startsWith('site,'))).toBe(true);

    const bad = await fetch(`${base}/api/central/export?part=guessed`);
    expect(bad.status).toBe(400);
  });

  it('GET /api/central/export?part=firmware|wlans|alerts dedicated CSVs (Loop 102)', async () => {
    const firmware = await fetch(`${base}/api/central/export?part=firmware`);
    expect(firmware.status).toBe(200);
    expect(firmware.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const fText = await firmware.text();
    expect(fText.split('\n')[0]).toBe('name,model,type,site,serial,firmware,target,update');
    expect(fText).not.toMatch(/api[_-]?key\s*[:=]|password|secret|token/i);

    const wlans = await fetch(`${base}/api/central/export?part=wlans`);
    expect(wlans.status).toBe(200);
    const wText = await wlans.text();
    expect(wText.split('\n')[0]).toBe('name,vlan,security,targets,plane,enabled');
    // Never ship PSK material — only inventory summary columns.
    expect(wText).not.toMatch(/passphrase|psk\s*[:=]|password/i);

    const alerts = await fetch(`${base}/api/central/export?part=alerts`);
    expect(alerts.status).toBe(200);
    const aText = await alerts.text();
    expect(aText.split('\n')[0]).toBe('sev,title,site,plane,age,device,state');
    expect(aText).not.toMatch(/api[_-]?key\s*[:=]|password|secret|token/i);
  });

  it('GET /api/central still returns the dashboard envelope', async () => {
    const r = await fetch(`${base}/api/central`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dataSource: string; sites: unknown[]; fleet: unknown };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.sites)).toBe(true);
    expect(body.fleet).toBeTruthy();
  });
});
