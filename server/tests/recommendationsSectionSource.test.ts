/**
 * server/tests/recommendationsSectionSource.test.ts — recommendations must
 * describe the estate the screens are describing.
 *
 * Every other consumer of the inventory decides its source with
 * effectiveSectionSource(): the notifier, the alert engine and the fleet
 * report all do, and each comments that it must watch the SAME estate the
 * operator is looking at. This route decided with the portal-wide demoMode
 * flag alone, so it ignored per-section overrides and the blend swap — an
 * operator who pinned Devices to live still got advice derived from the
 * authored fixtures, and nothing disclosed it because nothing had failed.
 *
 * Device count is the discriminator: the stubbed live cache holds exactly one
 * device, and the authored estate holds many.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLIENTS, DEVICES, type ClientRow, type DeviceRow } from '@hpe/shared';

const tmpDir = mkdtempSync(join(tmpdir(), 'hpe-recs-source-'));
process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
process.env.HPE_DATA_DIR = join(tmpDir, 'data');

let poller: typeof import('../src/services/poller').poller;
let settings: typeof import('../src/config/settings').settings;
let server: import('node:http').Server;
let base: string;

beforeAll(async () => {
  const express = (await import('express')).default;
  const { recommendationsRouter } = await import('../src/routes/recommendations');
  ({ poller } = await import('../src/services/poller'));
  ({ settings } = await import('../src/config/settings'));
  const app = express();
  app.use('/api', recommendationsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((ready) => server.once('listening', () => ready()));
  const { port } = server.address() as import('node:net').AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done())));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Exactly one live device and one live client, so any count above one is the
 *  authored estate answering instead. */
function stubOneOfEach(): void {
  const device = {
    name: 'live-sw-01',
    plane: 'CENTRAL',
    model: 'CX 6300',
    type: 'switch',
    siteId: 'live-site',
    siteName: 'Live Site',
    state: 'up',
    firmware: '10.10',
    firmwareApproved: true,
    licence: 'Foundation',
    reconciliationIssue: false,
    localShell: false,
  } as unknown as DeviceRow;
  const client = {
    name: 'live-client-01',
    mac: 'aa:bb:cc:00:00:01',
    type: 'unknown',
    model: 'unknown',
    siteId: 'live-site',
    siteName: 'Live Site',
    plane: 'CENTRAL',
    ip: '10.0.0.5',
    problem: false,
    health: 'good',
    auth: 'MAB',
    role: 'role Unclassified',
  } as unknown as ClientRow;
  vi.spyOn(poller, 'getCache').mockReturnValue({
    devices: [device],
    clients: [client],
    endpoints: [],
  } as never);
}

async function summary(): Promise<{ devices: { total: number }; clients: { total: number } }> {
  const res = await fetch(`${base}/api/taxonomy/summary`);
  return (await res.json()) as { devices: { total: number }; clients: { total: number } };
}

describe('recommendations follow each screen\u2019s own source', () => {
  it('honours a per-section override that pins devices to live', async () => {
    // The operator asked for their real switches on the Devices screen. The
    // advice about those switches must not come from the authored estate.
    settings.update({ demoMode: true, blendLive: false, sectionMode: { devices: 'live', clients: 'demo' } });
    stubOneOfEach();

    const body = await summary();
    expect(body.devices.total).toBe(1);
    expect(DEVICES.length).toBeGreaterThan(1); // the estate it used to answer with
  });

  it('honours a per-section override that pins devices to demo', async () => {
    // And the reverse: a section pinned to demo must not be analysed live.
    settings.update({ demoMode: false, blendLive: false, sectionMode: { devices: 'demo', clients: 'live' } });
    stubOneOfEach();

    const body = await summary();
    expect(body.devices.total).toBe(DEVICES.length);
  });

  it('decides each dataset on its own section, not one flag for both', async () => {
    settings.update({ demoMode: true, blendLive: false, sectionMode: { devices: 'demo', clients: 'live' } });
    stubOneOfEach();

    const body = await summary();
    expect(body.devices.total).toBe(DEVICES.length);
    expect(body.clients.total).toBe(1);
  });

  it('takes the blend swap when a plane has reported', async () => {
    // blendLive means a demo section swaps to real rows as soon as a plane
    // reports them. The screens do this; the advice about them did not.
    settings.update({ demoMode: true, blendLive: true, sectionMode: {} });
    stubOneOfEach();

    const body = await summary();
    expect(body.devices.total).toBe(1);
    expect(body.clients.total).toBe(1);
  });

  it('keeps the authored estate when demo mode has nothing live to swap in', async () => {
    // Guard: blend only displaces fixtures when rows actually arrived.
    settings.update({ demoMode: true, blendLive: true, sectionMode: {} });
    vi.spyOn(poller, 'getCache').mockReturnValue({ devices: [], clients: [], endpoints: [] } as never);

    const body = await summary();
    expect(body.devices.total).toBe(DEVICES.length);
    expect(body.clients.total).toBe(CLIENTS.length);
  });

  it('serves the live estate in plain live mode', async () => {
    // Guard: the ordinary case still behaves.
    settings.update({ demoMode: false, blendLive: false, sectionMode: {} });
    stubOneOfEach();

    const body = await summary();
    expect(body.devices.total).toBe(1);
    expect(body.clients.total).toBe(1);
  });
});
