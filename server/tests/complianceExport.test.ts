/**
 * GET /api/compliance + /api/compliance/export — extracted complianceScreen routes.
 * Export is findings metadata only (no full config diff dump).
 * Loop 75: baseline/sev/plane filters on list + export (stats stay full).
 * Loop 92: optional q= substring on title/detail/rule/device/plane/baseline.
 * Loop 122: shared queryString on baseline/sev/plane/fix/q (non-string no-op).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;
let applyComplianceFindingFilters: typeof import('../src/routes/screens/complianceScreen').applyComplianceFindingFilters;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-compliance-export-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  // Import only after env is set so settings/poller singletons bind to the temp paths.
  const { createApp } = await import('../src/index');
  ({ applyComplianceFindingFilters } = await import('../src/routes/screens/complianceScreen'));
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

describe('complianceScreen routes', () => {
  it('GET /api/compliance returns envelope with findings', async () => {
    const r = await fetch(`${base}/api/compliance`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      findings: unknown[];
      stats: unknown[];
      evidenceMode?: string;
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.findings)).toBe(true);
    expect(Array.isArray(body.stats)).toBe(true);
  });

  it('GET /api/compliance/export returns CSV without full diff dump', async () => {
    const r = await fetch(`${base}/api/compliance/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('sev');
    expect(header).toContain('title');
    expect(header).toContain('rule');
    // Honesty: export columns are finding metadata — never a free-form diff body column.
    expect(header.toLowerCase()).not.toContain('diff');
    // No credential-shaped columns or values (findings may mention "password" in policy text).
    expect(header).not.toMatch(/password|secret|token|api[_-]?key|authorization/i);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+|api[_-]?key\s*[:=]/i);
  });

  it('filters findings by sev and rejects unknown sev (Loop 75)', async () => {
    const full = (await (await fetch(`${base}/api/compliance`)).json()) as {
      findings: Array<{ sev?: string }>;
      stats: unknown[];
    };
    const high = (await (await fetch(`${base}/api/compliance?sev=high`)).json()) as {
      findings: Array<{ sev?: string }>;
      stats: unknown[];
    };
    expect(high.findings.every((f) => f.sev === 'high')).toBe(true);
    expect(high.findings.length).toBeLessThanOrEqual(full.findings.length);
    // Stats stay estate-wide so a severity filter cannot rewrite pass-rate.
    expect(high.stats).toEqual(full.stats);

    const exportHigh = await fetch(`${base}/api/compliance/export?sev=high`);
    expect(exportHigh.status).toBe(200);
    const csv = await exportHigh.text();
    const lines = csv.split('\n').filter((l) => l.trim().length > 0);
    const header = lines[0] ?? '';
    const sevIdx = header.split(',').indexOf('sev');
    expect(sevIdx).toBeGreaterThanOrEqual(0);
    for (const line of lines.slice(1)) {
      expect(line.split(',')[sevIdx]).toBe('high');
    }

    const bad = await fetch(`${base}/api/compliance?sev=critical`);
    expect(bad.status).toBe(400);
  });

  it('filters findings by q= substring on list + export (Loop 92)', async () => {
    const full = (await (await fetch(`${base}/api/compliance`)).json()) as {
      findings: Array<{ title?: string; detail?: string; rule?: string }>;
      stats: unknown[];
    };
    expect(full.findings.length).toBeGreaterThan(0);
    const needle = 'mtu';
    const filtered = (await (await fetch(`${base}/api/compliance?q=${needle}`)).json()) as {
      findings: Array<{ title?: string; detail?: string; rule?: string; device?: string }>;
      stats: unknown[];
    };
    expect(filtered.findings.length).toBeGreaterThan(0);
    expect(filtered.findings.length).toBeLessThanOrEqual(full.findings.length);
    expect(
      filtered.findings.every((f) =>
        [f.title, f.detail, f.rule, f.device].join(' ').toLowerCase().includes(needle),
      ),
    ).toBe(true);
    // Stats stay estate-wide under q= just like sev/plane.
    expect(filtered.stats).toEqual(full.stats);

    const exportQ = await fetch(`${base}/api/compliance/export?q=${needle}`);
    expect(exportQ.status).toBe(200);
    const csv = await exportQ.text();
    const lines = csv.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(line.toLowerCase()).toContain(needle);
    }
  });

  it('applyComplianceFindingFilters uses queryString (non-string no-op, Loop 122)', () => {
    const body = {
      findings: [
        { title: 'MTU drift', sev: 'high', fix: 'manual', plane: 'central', baseline: 'core' },
        { title: 'Unused VLAN', sev: 'low', fix: 'auto', plane: 'mist', baseline: 'edge' },
      ],
      stats: [{ id: 'pass', value: 90 }],
    };
    const full = applyComplianceFindingFilters({ query: {} } as unknown as Request, body);
    expect('body' in full && full.body.findings).toHaveLength(2);

    const arrayQ = applyComplianceFindingFilters(
      { query: { q: ['mtu'] } } as unknown as Request,
      body,
    );
    expect('body' in arrayQ && (arrayQ.body.findings as unknown[]).length).toBe(2);

    const trimmed = applyComplianceFindingFilters(
      { query: { q: '  mtu  ', sev: ' HIGH ' } } as unknown as Request,
      body,
    );
    expect('body' in trimmed).toBe(true);
    if ('body' in trimmed) {
      expect((trimmed.body.findings as Array<{ title?: string }>).map((f) => f.title)).toEqual([
        'MTU drift',
      ]);
      // Stats envelope is caller-owned; filter only touches findings[].
      expect(trimmed.body.stats).toEqual(body.stats);
    }

    const badSev = applyComplianceFindingFilters(
      { query: { sev: 'critical' } } as unknown as Request,
      body,
    );
    expect('error' in badSev).toBe(true);
  });

  it('filters findings by fix= and rejects unknown fix (Loop 110)', async () => {
    const full = (await (await fetch(`${base}/api/compliance`)).json()) as {
      findings: Array<{ fix?: string }>;
      stats: unknown[];
    };
    const manual = (await (await fetch(`${base}/api/compliance?fix=manual`)).json()) as {
      findings: Array<{ fix?: string }>;
      stats: unknown[];
    };
    expect(manual.findings.every((f) => String(f.fix ?? '').toLowerCase() === 'manual')).toBe(true);
    expect(manual.findings.length).toBeLessThanOrEqual(full.findings.length);
    expect(manual.stats).toEqual(full.stats);

    const exportManual = await fetch(`${base}/api/compliance/export?fix=manual`);
    expect(exportManual.status).toBe(200);
    const csv = await exportManual.text();
    const lines = csv.split('\n').filter((l) => l.trim().length > 0);
    const header = lines[0] ?? '';
    const fixIdx = header.split(',').indexOf('fix');
    expect(fixIdx).toBeGreaterThanOrEqual(0);
    for (const line of lines.slice(1)) {
      expect(line.split(',')[fixIdx]).toBe('manual');
    }

    const bad = await fetch(`${base}/api/compliance?fix=reboot`);
    expect(bad.status).toBe(400);
  });
});
