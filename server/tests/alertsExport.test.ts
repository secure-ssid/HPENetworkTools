/**
 * GET /api/alerts + /api/alerts/export — extracted alertsScreen routes.
 * Export is active groups (latest + count); "export" must not hit :fingerprint.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-alerts-export-'));
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

describe('alertsScreen routes', () => {
  it('GET /api/alerts returns envelope with groups', async () => {
    const r = await fetch(`${base}/api/alerts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      alerts: unknown[];
      groups: unknown[];
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
  });

  it('GET /api/alerts/export returns CSV of groups (not a fingerprint 404)', async () => {
    const r = await fetch(`${base}/api/alerts/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header.split(',')).toEqual([
      'sev',
      'title',
      'detail',
      'state',
      'plane',
      'site',
      'device',
      'count',
      'fingerprint',
    ]);
    expect(text).not.toMatch(/password|secret|token|apiKey/i);
  });

  it('GET /api/alerts?q= and /export?q= filter nested latest fields (Loop 71)', async () => {
    const all = await fetch(`${base}/api/alerts`);
    const allBody = (await all.json()) as {
      groups: Array<{ fingerprint: string; latest: { title: string; plane: string } }>;
    };
    expect(allBody.groups.length).toBeGreaterThan(0);
    const sample = allBody.groups[0]!;
    const needle = sample.latest.title.slice(0, Math.min(6, sample.latest.title.length));
    expect(needle.length).toBeGreaterThan(0);

    const hit = await fetch(`${base}/api/alerts?q=${encodeURIComponent(needle)}`);
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as { groups: Array<{ latest: { title: string } }> };
    expect(hitBody.groups.length).toBeGreaterThan(0);
    expect(hitBody.groups.length).toBeLessThanOrEqual(allBody.groups.length);
    for (const g of hitBody.groups) {
      expect(
        `${g.latest.title}`.toLowerCase().includes(needle.toLowerCase()) ||
          JSON.stringify(g).toLowerCase().includes(needle.toLowerCase()),
      ).toBe(true);
    }

    const miss = await fetch(`${base}/api/alerts?q=zzz-no-such-alert-token`);
    expect(miss.status).toBe(200);
    const missBody = (await miss.json()) as { groups: unknown[] };
    expect(missBody.groups).toEqual([]);

    const plane = sample.latest.plane;
    const byPlane = await fetch(`${base}/api/alerts?plane=${encodeURIComponent(plane)}`);
    expect(byPlane.status).toBe(200);
    const planeBody = (await byPlane.json()) as {
      groups: Array<{ latest: { plane: string } }>;
    };
    expect(planeBody.groups.length).toBeGreaterThan(0);
    for (const g of planeBody.groups) {
      expect(String(g.latest.plane).toLowerCase()).toBe(String(plane).toLowerCase());
    }

    const exp = await fetch(`${base}/api/alerts/export?q=${encodeURIComponent(needle)}`);
    expect(exp.status).toBe(200);
    const csv = await exp.text();
    expect(csv.split('\n').filter((l) => l.trim()).length).toBeGreaterThan(1);
    expect(csv.toLowerCase()).toContain(needle.toLowerCase());

    const expMiss = await fetch(`${base}/api/alerts/export?q=zzz-no-such-alert-token`);
    expect(expMiss.status).toBe(200);
    const missCsv = await expMiss.text();
    // header only
    expect(missCsv.trim().split('\n').length).toBe(1);
  });

  it('GET /api/alerts and /export honour sev and site (comma multi = OR; Loop 84)', async () => {
    const all = await fetch(`${base}/api/alerts`);
    const allBody = (await all.json()) as {
      groups: Array<{
        latest: { sev: string; siteName?: string; siteId?: string; plane: string };
      }>;
    };
    expect(allBody.groups.length).toBeGreaterThan(0);
    const sample = allBody.groups.find((g) => g.latest?.sev) ?? allBody.groups[0]!;
    const sev = String(sample.latest.sev);
    const bySev = await fetch(`${base}/api/alerts?sev=${encodeURIComponent(sev)}`);
    expect(bySev.status).toBe(200);
    const sevBody = (await bySev.json()) as { groups: Array<{ latest: { sev: string } }> };
    expect(sevBody.groups.length).toBeGreaterThan(0);
    expect(sevBody.groups.length).toBeLessThanOrEqual(allBody.groups.length);
    for (const g of sevBody.groups) {
      expect(String(g.latest.sev).toLowerCase()).toBe(sev.toLowerCase());
    }

    const multi = await fetch(`${base}/api/alerts?sev=p1,p2,p3,p9`);
    expect(multi.status).toBe(200);
    const multiBody = (await multi.json()) as { groups: unknown[] };
    // Unknown token p9 is ignored as a match candidate; P1–P3 still match.
    expect(multiBody.groups.length).toBeGreaterThan(0);

    const siteName = String(sample.latest.siteName ?? '').trim();
    const siteId = String(sample.latest.siteId ?? '').trim();
    if (siteName) {
      const bySite = await fetch(`${base}/api/alerts?site=${encodeURIComponent(siteName)}`);
      expect(bySite.status).toBe(200);
      const siteBody = (await bySite.json()) as {
        groups: Array<{ latest: { siteName?: string } }>;
      };
      expect(siteBody.groups.length).toBeGreaterThan(0);
      for (const g of siteBody.groups) {
        expect(String(g.latest.siteName ?? '').toLowerCase()).toBe(siteName.toLowerCase());
      }
    }
    if (siteId) {
      const byId = await fetch(`${base}/api/alerts?site=${encodeURIComponent(siteId)}`);
      expect(byId.status).toBe(200);
      const idBody = (await byId.json()) as {
        groups: Array<{ latest: { siteId?: string } }>;
      };
      expect(idBody.groups.length).toBeGreaterThan(0);
      for (const g of idBody.groups) {
        expect(String(g.latest.siteId ?? '').toLowerCase()).toBe(siteId.toLowerCase());
      }
    }

    const exp = await fetch(`${base}/api/alerts/export?sev=${encodeURIComponent(sev)}`);
    expect(exp.status).toBe(200);
    const csv = await exp.text();
    const dataRows = csv
      .trim()
      .split('\n')
      .slice(1)
      .filter((l) => l.trim());
    expect(dataRows.length).toBe(sevBody.groups.length);
    for (const row of dataRows) {
      // First column is sev.
      expect(row.split(',')[0]?.toLowerCase()).toBe(sev.toLowerCase());
    }

    const miss = await fetch(`${base}/api/alerts/export?sev=p9-not-real`);
    expect(miss.status).toBe(200);
    expect((await miss.text()).trim().split('\n').length).toBe(1);
  });

  it('applyAlertQueueFilters honours unacked + cleared (Loop 90/118)', async () => {
    const { applyAlertQueueFilters } = await import('../src/routes/screens/alertsScreen');
    const body = {
      groups: [
        { fingerprint: 'a', latest: { state: 'open', title: 'A', sev: 'P1' } },
        { fingerprint: 'b', latest: { state: 'acked', title: 'B', sev: 'P2' } },
        { fingerprint: 'c', latest: { state: 'cleared', title: 'C', sev: 'P3' } },
      ],
    };
    const unacked = applyAlertQueueFilters({ query: { unacked: '1' } }, body) as {
      groups: Array<{ fingerprint: string }>;
    };
    expect(unacked.groups.map((g) => g.fingerprint)).toEqual(['a']);

    const hideCleared = applyAlertQueueFilters({ query: { cleared: '0' } }, body) as {
      groups: Array<{ fingerprint: string }>;
    };
    expect(hideCleared.groups.map((g) => g.fingerprint)).toEqual(['a', 'b']);

    const showCleared = applyAlertQueueFilters({ query: { cleared: '1' } }, body) as {
      groups: Array<{ fingerprint: string }>;
    };
    expect(showCleared.groups.map((g) => g.fingerprint)).toEqual(['a', 'b', 'c']);

    const both = applyAlertQueueFilters({ query: { unacked: 'true', cleared: 'false' } }, body) as {
      groups: Array<{ fingerprint: string }>;
    };
    expect(both.groups.map((g) => g.fingerprint)).toEqual(['a']);

    // Loop 118: shared queryFlag accepts yes/on/no/off aliases.
    const unackedYes = applyAlertQueueFilters({ query: { unacked: 'yes' } }, body) as {
      groups: Array<{ fingerprint: string }>;
    };
    expect(unackedYes.groups.map((g) => g.fingerprint)).toEqual(['a']);
    const unackedOn = applyAlertQueueFilters({ query: { unacked: 'ON' } }, body) as {
      groups: Array<{ fingerprint: string }>;
    };
    expect(unackedOn.groups.map((g) => g.fingerprint)).toEqual(['a']);
    const hideOff = applyAlertQueueFilters({ query: { cleared: 'off' } }, body) as {
      groups: Array<{ fingerprint: string }>;
    };
    expect(hideOff.groups.map((g) => g.fingerprint)).toEqual(['a', 'b']);
    const hideNo = applyAlertQueueFilters({ query: { cleared: 'NO' } }, body) as {
      groups: Array<{ fingerprint: string }>;
    };
    expect(hideNo.groups.map((g) => g.fingerprint)).toEqual(['a', 'b']);
    // Trim via shared queryString.
    const qTrim = applyAlertQueueFilters({ query: { q: '  A  ' } }, body) as {
      groups: Array<{ fingerprint: string }>;
    };
    expect(qTrim.groups.map((g) => g.fingerprint)).toEqual(['a']);

    // Absent flags leave the full queue (backward compatible).
    const all = applyAlertQueueFilters({ query: {} }, body) as { groups: unknown[] };
    expect(all.groups).toHaveLength(3);
  });

  it('GET /api/alerts?unacked=1 and export?cleared=0 apply state gates (Loop 90)', async () => {
    const all = await fetch(`${base}/api/alerts`);
    const allBody = (await all.json()) as {
      groups: Array<{ latest: { state: string } }>;
    };
    expect(allBody.groups.length).toBeGreaterThan(0);

    const unacked = await fetch(`${base}/api/alerts?unacked=1`);
    expect(unacked.status).toBe(200);
    const unackedBody = (await unacked.json()) as {
      groups: Array<{ latest: { state: string } }>;
    };
    expect(unackedBody.groups.every((g) => g.latest.state === 'open')).toBe(true);
    expect(unackedBody.groups.length).toBeLessThanOrEqual(allBody.groups.length);

    const hide = await fetch(`${base}/api/alerts/export?cleared=0`);
    expect(hide.status).toBe(200);
    const csv = await hide.text();
    const header = csv.split('\n')[0] ?? '';
    // state is the 4th column (sev,title,detail,state,…)
    const stateIdx = header.split(',').indexOf('state');
    expect(stateIdx).toBeGreaterThanOrEqual(0);
    for (const line of csv.trim().split('\n').slice(1).filter((l) => l.trim())) {
      const cols = line.split(',');
      expect(cols[stateIdx]?.toLowerCase()).not.toBe('cleared');
    }
  });

  it('GET /api/alerts/:fp/timeline and timeline/export serve the same group', async () => {
    const list = await fetch(`${base}/api/alerts`);
    const body = (await list.json()) as {
      groups: Array<{ fingerprint: string }>;
    };
    const fp = body.groups[0]?.fingerprint;
    expect(fp).toBeTruthy();
    const enc = encodeURIComponent(fp!);

    const tl = await fetch(`${base}/api/alerts/${enc}/timeline`);
    expect(tl.status).toBe(200);
    const tlBody = (await tl.json()) as { timeline: { events: unknown[] } };
    expect(Array.isArray(tlBody.timeline?.events)).toBe(true);

    const exp = await fetch(`${base}/api/alerts/${enc}/timeline/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const csv = await exp.text();
    const header = csv.split('\n')[0] ?? '';
    expect(header).toContain('fingerprint');
    expect(header).toContain('ts');
    expect(header).toContain('kind');
    expect(header).toContain('label');
    expect(csv).not.toMatch(/password|secret|token|apiKey/i);

    const unknown = await fetch(`${base}/api/alerts/no-such-fp/timeline/export`);
    expect(unknown.status).toBe(404);
  });
});
