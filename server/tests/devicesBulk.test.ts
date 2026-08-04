/**
 * GET /api/devices/bulk — serial lookup, no fabrication, and an honest cap.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICES } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-bulk-'));
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

describe('GET /api/devices/bulk', () => {
  it('requires serials', async () => {
    const r = await fetch(`${base}/api/devices/bulk`);
    expect(r.status).toBe(400);
  });

  it('returns matching demo devices and missing serials', async () => {
    const withSerial = DEVICES.filter((d) => d.serial && String(d.serial).trim()).slice(0, 2);
    if (withSerial.length === 0) return;
    const serials = withSerial.map((d) => String(d.serial));
    const ghost = 'ZZ-NOT-A-REAL-SERIAL-000';
    const r = await fetch(
      `${base}/api/devices/bulk?serials=${encodeURIComponent([...serials, ghost].join(','))}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      devices: Array<{ serial?: string }>;
      missing: string[];
      requested: number;
    };
    expect(body.requested).toBe(serials.length + 1);
    expect(body.devices.length).toBeGreaterThanOrEqual(1);
    expect(body.missing).toContain(ghost);
  });
});

type BulkBody = {
  devices: Array<{ serial?: string }>;
  missing: string[];
  requested: number;
  notExamined?: string[];
  limit?: number;
};

/** Distinct serials that match nothing in the demo estate. */
function ghosts(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `GHOST-${String(i).padStart(4, '0')}`);
}

async function bulk(serials: string[]): Promise<BulkBody> {
  const r = await fetch(`${base}/api/devices/bulk?serials=${encodeURIComponent(serials.join(','))}`);
  expect(r.status).toBe(200);
  return (await r.json()) as BulkBody;
}

describe('GET /api/devices/bulk past the 50-serial cap', () => {
  it('counts what the caller asked for, not what survived the cap', async () => {
    const asked = ghosts(58);
    const body = await bulk(asked);
    expect(body.requested).toBe(58);
  });

  it('returns the serials it never examined instead of dropping them', async () => {
    const asked = ghosts(58);
    const body = await bulk(asked);
    expect(body.notExamined).toHaveLength(8);
    expect(body.notExamined).toEqual(asked.slice(50));
    expect(body.limit).toBe(50);
  });

  it('accounts for every requested serial exactly once', async () => {
    const asked = ghosts(58);
    const body = await bulk(asked);
    const seen = [
      ...body.devices.map((d) => String(d.serial ?? '')),
      ...body.missing,
      ...(body.notExamined ?? []),
    ];
    expect(seen).toHaveLength(asked.length);
    expect(new Set(seen.map((s) => s.toLowerCase()))).toEqual(
      new Set(asked.map((s) => s.toLowerCase())),
    );
  });

  it('does not report an unexamined serial as absent from the estate', async () => {
    const asked = ghosts(58);
    const body = await bulk(asked);
    // The whole point of the split: `missing` is a claim about the estate, and
    // a serial nobody looked up cannot support that claim. Assert the overlap
    // is empty *and* that there was something to overlap, so this cannot pass
    // by there being no unexamined serials to check.
    expect(body.notExamined ?? []).not.toHaveLength(0);
    expect(body.missing).toHaveLength(50);
    for (const serial of body.notExamined ?? []) {
      expect(body.missing).not.toContain(serial);
    }
  });

  it('says nothing about a cap that did not apply', async () => {
    const body = await bulk(ghosts(3));
    expect(body.requested).toBe(3);
    expect(body.notExamined).toBeUndefined();
    expect(body.limit).toBeUndefined();
  });

  it('counts distinct serials, so duplicates do not consume the cap', async () => {
    const asked = ghosts(40);
    const body = await bulk([...asked, ...asked]);
    expect(body.requested).toBe(40);
    expect(body.notExamined).toBeUndefined();
  });
});
