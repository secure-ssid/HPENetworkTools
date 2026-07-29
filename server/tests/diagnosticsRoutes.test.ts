import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceRow } from '../../shared';
import { SettingsStore } from '../src/config/settings';
import { PlaneRegistry } from '../src/planes/registry';
import { createDiagnosticsRouter } from '../src/routes/diagnostics';
import { DiagnosticsService } from '../src/services/diagnostics';

const root = path.resolve(process.cwd(), '.diagnostics-route-test-data');
let server: Server;
let base: string;

const AP: DeviceRow = {
  name: 'ap-route',
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
  serial: 'AP-ROUTE',
};

beforeAll(async () => {
  fs.rmSync(root, { recursive: true, force: true });
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
  const service = new DiagnosticsService({
    registry: new PlaneRegistry(store),
    liveDevices: () => [AP],
    dataDir: root,
    transport: {
      request: async (_method, requestPath) => ({
        status: 202,
        body: { location: `${requestPath}/async-operations/route-task` },
      }),
    },
  });
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

describe('/api/diagnostics routes', () => {
  it('serves live eligibility and validates review input', async () => {
    const eligible = await fetch(`${base}/api/diagnostics/eligible`);
    expect(eligible.status).toBe(200);
    expect(await eligible.json()).toMatchObject({
      operation: 'traceroute',
      source: 'live-inventory',
      devices: [{ name: 'ap-route', eligible: true }],
    });

    const invalid = await fetch(`${base}/api/diagnostics/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        plane: 'CENTRAL',
        serial: 'AP-ROUTE',
        operation: 'traceroute',
        target: 'https://bad.example',
      }),
    });
    expect(invalid.status).toBe(400);

    const displayNameOnly = await fetch(`${base}/api/diagnostics/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device: 'ap-route', operation: 'traceroute', target: 'example.net' }),
    });
    expect(displayNameOnly.status).toBe(400);
  });

  it('enforces the review/confirmation gate before returning an async job', async () => {
    const reviewed = await fetch(`${base}/api/diagnostics/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        plane: 'CENTRAL',
        serial: 'AP-ROUTE',
        operation: 'traceroute',
        target: 'example.net',
      }),
    });
    const review = await reviewed.json() as { reviewId: string; plane: string; serial: string };

    const unconfirmed = await fetch(`${base}/api/diagnostics/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reviewId: review.reviewId,
        confirmed: false,
        plane: review.plane,
        serial: review.serial,
      }),
    });
    expect(unconfirmed.status).toBe(400);

    const started = await fetch(`${base}/api/diagnostics/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reviewId: review.reviewId,
        confirmed: true,
        plane: review.plane,
        serial: review.serial,
      }),
    });
    expect(started.status).toBe(202);
    const job = await started.json() as { id: string; state: string; taskId: string };
    expect(job).toMatchObject({
      state: 'running',
      taskId: 'route-task',
      device: 'ap-route',
      serial: 'AP-ROUTE',
      plane: 'CENTRAL',
    });
    const cancelled = await fetch(`${base}/api/diagnostics/jobs/${job.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(cancelled.status).toBe(200);
  });
});
