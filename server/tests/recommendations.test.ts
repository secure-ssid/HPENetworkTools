import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let createApp: typeof import('../src/index').createApp;

let tmpDir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  const testRoot = resolve(process.cwd(), '.agent-tmp');
  mkdirSync(testRoot, { recursive: true });
  tmpDir = mkdtempSync(join(testRoot, 'recs-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  writeFileSync(
    process.env.HPE_SETTINGS_PATH,
    JSON.stringify({ demoMode: true, blendLive: false }),
  );
  ({ createApp } = await import('../src/index'));
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) =>
    server.close((err) => (err ? reject(err) : resolveClose())),
  );
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

describe('recommendations API', () => {
  it('returns read-only recommendations for the demo estate', async () => {
    const res = await fetch(`${base}/api/recommendations?limit=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recommendations: Array<{ id: string; ruleId: string }>;
      readOnly: boolean;
      counts: { total: number };
    };
    expect(body.readOnly).toBe(true);
    expect(body.counts.total).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });

  it('filters by device name', async () => {
    const res = await fetch(`${base}/api/recommendations?device=ap-3f-14`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recommendations: Array<{ device?: string }> };
    expect(body.recommendations.every((r) => r.device === 'ap-3f-14')).toBe(true);
  });

  it('returns taxonomy summary buckets', async () => {
    const res = await fetch(`${base}/api/taxonomy/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devices: { total: number; byType: Array<{ key: string; count: number }> };
      clients: { total: number; byType: Array<{ key: string; count: number }> };
    };
    expect(body.devices.total).toBeGreaterThan(0);
    expect(body.devices.byType.some((b) => b.key === 'switch' || b.key === 'ap')).toBe(true);
    expect(body.clients.total).toBeGreaterThan(0);
  });

  it('GET /api/recommendations/export returns CSV without secrets (Loop 84)', async () => {
    const res = await fetch(`${base}/api/recommendations/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await res.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('severity');
    expect(header).toContain('category');
    expect(header).toContain('title');
    expect(header).toContain('handoffPath');
    expect(header).not.toMatch(/\b(password|secret|token|apiKey|body|payload)\b/i);
    expect(text.split('\n').filter((l) => l.trim()).length).toBeGreaterThan(1);
  });

  it('export honours severity/category/device filters like the JSON list (Loop 84)', async () => {
    const all = await fetch(`${base}/api/recommendations?limit=200`);
    const allBody = (await all.json()) as {
      recommendations: Array<{
        severity: string;
        category: string;
        device?: string;
        title: string;
      }>;
    };
    expect(allBody.recommendations.length).toBeGreaterThan(0);
    const sample = allBody.recommendations[0]!;

    const bySev = await fetch(
      `${base}/api/recommendations/export?severity=${encodeURIComponent(sample.severity)}`,
    );
    expect(bySev.status).toBe(200);
    const sevCsv = await bySev.text();
    const sevRows = sevCsv
      .trim()
      .split('\n')
      .slice(1)
      .filter((l) => l.trim());
    expect(sevRows.length).toBeGreaterThan(0);
    // severity is column index 2 (id, ruleId, severity, …)
    for (const row of sevRows) {
      const cols = row.split(',');
      expect(cols[2]?.toLowerCase()).toBe(sample.severity.toLowerCase());
    }

    const byCat = await fetch(
      `${base}/api/recommendations/export?category=${encodeURIComponent(sample.category)}`,
    );
    expect(byCat.status).toBe(200);
    const catCsv = await byCat.text();
    const catRows = catCsv
      .trim()
      .split('\n')
      .slice(1)
      .filter((l) => l.trim());
    expect(catRows.length).toBeGreaterThan(0);
    // category is column index 5
    for (const row of catRows) {
      expect(row.toLowerCase()).toContain(sample.category.toLowerCase());
    }

    if (sample.device) {
      const byDev = await fetch(
        `${base}/api/recommendations/export?device=${encodeURIComponent(sample.device)}`,
      );
      expect(byDev.status).toBe(200);
      const devCsv = await byDev.text();
      const devRows = devCsv
        .trim()
        .split('\n')
        .slice(1)
        .filter((l) => l.trim());
      expect(devRows.length).toBeGreaterThan(0);
      for (const row of devRows) {
        expect(row.toLowerCase()).toContain(sample.device!.toLowerCase());
      }
    }

    const jsonSev = await fetch(
      `${base}/api/recommendations?severity=${encodeURIComponent(sample.severity)}&limit=200`,
    );
    const jsonBody = (await jsonSev.json()) as { recommendations: unknown[] };
    expect(sevRows.length).toBe(jsonBody.recommendations.length);
  });

  it('unknown severity/category are honest no-ops; bad limit is 400 (Loop 114)', async () => {
    const all = await fetch(`${base}/api/recommendations?limit=200`);
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { recommendations: unknown[]; counts: { total: number } };

    const bogusSev = await fetch(`${base}/api/recommendations?severity=critical&limit=200`);
    expect(bogusSev.status).toBe(200);
    const bogusSevBody = (await bogusSev.json()) as { counts: { total: number } };
    expect(bogusSevBody.counts.total).toBe(allBody.counts.total);

    const bogusCat = await fetch(`${base}/api/recommendations?category=not-a-category&limit=200`);
    expect(bogusCat.status).toBe(200);
    const bogusCatBody = (await bogusCat.json()) as { counts: { total: number } };
    expect(bogusCatBody.counts.total).toBe(allBody.counts.total);

    const caseSev = await fetch(`${base}/api/recommendations?severity=WARNING&limit=200`);
    expect(caseSev.status).toBe(200);
    const caseBody = (await caseSev.json()) as {
      recommendations: Array<{ severity: string }>;
    };
    expect(caseBody.recommendations.length).toBeGreaterThan(0);
    expect(caseBody.recommendations.every((r) => r.severity === 'warning')).toBe(true);

    const badLimit = await fetch(`${base}/api/recommendations?limit=1.5`);
    expect(badLimit.status).toBe(400);
    const badBody = (await badLimit.json()) as { code?: string };
    expect(badBody.code).toBe('RECOMMENDATION_VALIDATION');

    const sciLimit = await fetch(`${base}/api/recommendations?limit=1e2`);
    expect(sciLimit.status).toBe(400);

    // Export still ignores limit and treats unknown severity as no-op.
    const exp = await fetch(`${base}/api/recommendations/export?severity=nope&limit=1`);
    expect(exp.status).toBe(200);
    const expRows = (await exp.text()).trim().split('\n').filter(Boolean).length - 1;
    expect(expRows).toBe(allBody.recommendations.length);
  });
});
