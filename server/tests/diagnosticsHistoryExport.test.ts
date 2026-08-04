/**
 * Loop 101 — GET /api/diagnostics/history/export (+ device/plane/state filters).
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceRow } from '@hpe/shared';
import { SettingsStore } from '../src/config/settings';
import { PlaneRegistry } from '../src/planes/registry';
import { createDiagnosticsRouter } from '../src/routes/diagnostics';
import { DiagnosticsService } from '../src/services/diagnostics';

const root = path.resolve(process.cwd(), '.agent-tmp', 'diagnostics-history-export');
let server: Server;
let base: string;
let service: DiagnosticsService;

const AP: DeviceRow = {
  name: 'ap-export',
  model: 'AP-635',
  type: 'ap',
  siteId: 'campus-01',
  siteName: 'Campus-01',
  plane: 'CENTRAL',
  planeTone: 'accent',
  state: 'up',
  stateTone: 'success',
  firmware: '10.7',
  firmwareApproved: true,
  licence: 'foundation',
  reconciliationIssue: false,
  localShell: false,
  serial: 'AP-EXPORT',
};

beforeAll(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = new SettingsStore(path.join(root, 'settings.json'));
  store.load();
  store.update({
    planes: {
      central: {
        gatewayBaseUrl: 'https://internal.api.central.arubanetworks.com',
        clientId: 'id',
        clientSecret: 'secret',
      },
    },
  });
  service = new DiagnosticsService({
    registry: new PlaneRegistry(store),
    liveDevices: () => [AP],
    dataDir: root,
    transport: {
      request: async (_method, requestPath) => ({
        status: 202,
        body: { location: `${requestPath}/async-operations/export-task` },
      }),
    },
  });

  // Seed one reviewed + started run so history has a real audit line.
  const review = service.review({
    plane: 'CENTRAL',
    serial: 'AP-EXPORT',
    operation: 'traceroute',
    target: '8.8.8.8',
  });
  await service.start(review.reviewId, true, 'CENTRAL', 'AP-EXPORT');

  const app = express();
  app.use(express.json());
  app.use('/api', createDiagnosticsRouter(service));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('diagnostics history export (Loop 101)', () => {
  it('GET /api/diagnostics/history/export returns redacted audit CSV', async () => {
    const r = await fetch(`${base}/api/diagnostics/history/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('at');
    expect(header).toContain('device');
    expect(header).toContain('serial');
    expect(header).toContain('plane');
    expect(header).toContain('state');
    expect(header).toContain('target');
    expect(text).toMatch(/ap-export|AP-EXPORT/);
    expect(text).toContain('[redacted]');
    expect(text).not.toMatch(/8\.8\.8\.8|password|secret|bearer\s+[A-Za-z0-9]/i);
    expect(text.trim().split('\n').length).toBeGreaterThan(1);
  });

  it('honours device= filter on list and export', async () => {
    const list = await fetch(`${base}/api/diagnostics/history?device=ap-export`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { entries: Array<{ device: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    for (const e of body.entries) expect(e.device.toLowerCase()).toBe('ap-export');

    const miss = await fetch(`${base}/api/diagnostics/history/export?device=no-such-device`);
    expect(miss.status).toBe(200);
    const missRows = (await miss.text()).trim().split('\n').filter(Boolean).length - 1;
    expect(missRows).toBe(0);

    const hit = await fetch(`${base}/api/diagnostics/history/export?device=AP-EXPORT`);
    const hitRows = (await hit.text()).trim().split('\n').filter(Boolean).length - 1;
    expect(hitRows).toBeGreaterThan(0);
  });

  it('honours q= substring filter on list and export (Loop 114)', async () => {
    const { filterDiagnosticHistoryEntries } = await import('../src/routes/diagnostics');
    type Entry = import('@hpe/shared').DiagnosticAuditEntry;
    const sample: Entry[] = [
      {
        at: '2026-08-04T01:00:00.000Z',
        id: 'job-trace-1',
        device: 'ap-export',
        serial: 'SN-EXPORT-1',
        plane: 'MIST',
        operation: 'traceroute',
        state: 'succeeded',
        target: '[redacted]',
      },
      {
        at: '2026-08-04T01:05:00.000Z',
        id: 'job-trace-2',
        device: 'sw-core',
        serial: 'SN-CORE-9',
        plane: 'CENTRAL',
        operation: 'traceroute',
        state: 'failed',
        target: '[redacted]',
      },
    ];
    const req = (query: Record<string, unknown>) => ({ query }) as any;
    expect(filterDiagnosticHistoryEntries(req({ q: 'failed' }), sample).map((e) => e.id)).toEqual([
      'job-trace-2',
    ]);
    expect(filterDiagnosticHistoryEntries(req({ q: 'MIST' }), sample).map((e) => e.id)).toEqual([
      'job-trace-1',
    ]);
    expect(filterDiagnosticHistoryEntries(req({ q: 'sn-export' }), sample).map((e) => e.id)).toEqual([
      'job-trace-1',
    ]);
    expect(filterDiagnosticHistoryEntries(req({ q: 'nope' }), sample)).toEqual([]);
    expect(filterDiagnosticHistoryEntries(req({}), sample)).toHaveLength(2);
    // q combines with exact filters (AND)
    expect(
      filterDiagnosticHistoryEntries(req({ q: 'job', plane: 'central' }), sample).map((e) => e.id),
    ).toEqual(['job-trace-2']);

    const list = await fetch(`${base}/api/diagnostics/history?q=ap-export`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { entries: Array<{ device: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    for (const e of body.entries) {
      expect(JSON.stringify(e).toLowerCase()).toContain('ap-export');
    }

    const csv = await fetch(`${base}/api/diagnostics/history/export?q=ap-export`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text.toLowerCase()).toContain('ap-export');
    expect(text).toContain('[redacted]');
  });
});
