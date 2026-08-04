/**
 * Loop 101 — GET /api/metrics/export?part=series|anomalies
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METRICS_DEMO_NOTE, METRICS_EXPORT_PARTS } from '@hpe/shared';
import { createMetricsRouter } from '../src/routes/metrics';
import { MetricsHistoryService } from '../src/services/metricsHistory';

let server: Server;
let base: string;

beforeAll(async () => {
  const service = new MetricsHistoryService({
    liveSampling: () => false,
    nowMs: () => Date.parse('2026-08-04T12:00:00Z'),
  });
  const app = express();
  app.use('/api', createMetricsRouter(service));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('metrics export (Loop 101)', () => {
  it('GET /api/metrics/export defaults to series CSV of count samples', async () => {
    const r = await fetch(`${base}/api/metrics/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toBe('scope,key,metric,t,v');
    expect(text).toMatch(/plane,/);
    expect(text).toMatch(/devices|clients|alerts/);
    expect(text).not.toMatch(/password|secret|token|bearer\s+[A-Za-z0-9]/i);
    expect(text.trim().split('\n').length).toBeGreaterThan(1);
    // Demo envelope note is JSON-only — not a CSV column.
    expect(text).not.toContain(METRICS_DEMO_NOTE);
  });

  it('part=anomalies returns flag columns (may be header-only on short demo rings)', async () => {
    const r = await fetch(`${base}/api/metrics/export?part=anomalies`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.split('\n')[0]).toBe('scope,key,metric,t,v,direction,z,index');
    expect(text).not.toMatch(/password|secret|hmac/i);
  });

  it('unknown part is 400', async () => {
    const r = await fetch(`${base}/api/metrics/export?part=raw`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain(METRICS_EXPORT_PARTS.join('|'));
  });
});
