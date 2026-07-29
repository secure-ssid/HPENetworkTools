/**
 * server/tests/terminalSessionsRoutes.test.ts — HTTP-level contract for
 * GET /api/terminal/sessions and GET /api/terminal/sessions/:file
 * (server/src/index.ts). Exercises the query-string wiring (device / plane /
 * serial) into terminalManager.listSessionsForDevice / readSessionForDevice —
 * the unit behaviour of those two is covered exhaustively in
 * tests/terminal.test.ts, so this file only checks that the route passes the
 * request through correctly and maps invalid/ambiguous/missing to the right
 * HTTP status.
 *
 * HPE_SHELL_LOG_DIR points the process-wide terminalManager singleton at a
 * tmp dir for the lifetime of this file, exactly like HPE_SETTINGS_PATH /
 * HPE_DATA_DIR in routes.test.ts — recordings written here never touch the
 * real data/shell-logs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;
let logDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-terminal-routes-'));
  logDir = join(tmpDir, 'shell-logs');
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  process.env.HPE_SHELL_LOG_DIR = logDir;
  mkdirSync(logDir, { recursive: true });
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
  delete process.env.HPE_SHELL_LOG_DIR;
});

function writeOpen(file: string, at: string, text: string): void {
  writeFileSync(join(logDir, file), JSON.stringify({ type: 'open', at, text }) + '\n');
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /api/terminal/sessions', () => {
  it('with no ?device= returns the unscoped listing (admin dump, no name to disambiguate)', async () => {
    writeOpen('unscoped-a.jsonl', '2026-01-01T09:00:00.000Z', 'device=unscoped-a user=x target=10.0.0.1');
    const { status, body } = await getJson('/api/terminal/sessions');
    expect(status).toBe(200);
    expect(body.sessions.some((s: { device: string }) => s.device === 'unscoped-a')).toBe(true);
  });

  it('?device=&plane=&serial= returns only that identity\u2019s recordings for a shared name', async () => {
    writeOpen(
      'route-shared-a.jsonl',
      '2026-01-02T09:00:00.000Z',
      'device=route-shared user=alice target=10.2.2.1 plane=LOCAL serial=ROUTE-A identity=LOCAL/ROUTE-A',
    );
    writeOpen(
      'route-shared-b.jsonl',
      '2026-01-02T09:01:00.000Z',
      'device=route-shared user=bob target=10.2.2.2 plane=CENTRAL serial=ROUTE-B identity=CENTRAL/ROUTE-B',
    );

    const a = await getJson('/api/terminal/sessions?device=route-shared&plane=LOCAL&serial=ROUTE-A');
    expect(a.status).toBe(200);
    expect(a.body.ambiguous).toBe(false);
    expect(a.body.sessions).toHaveLength(1);
    expect(a.body.sessions[0]).toMatchObject({ user: 'alice', plane: 'LOCAL', serial: 'ROUTE-A' });

    const b = await getJson('/api/terminal/sessions?device=route-shared&plane=CENTRAL&serial=ROUTE-B');
    expect(b.status).toBe(200);
    expect(b.body.sessions).toHaveLength(1);
    expect(b.body.sessions[0]).toMatchObject({ user: 'bob', plane: 'CENTRAL', serial: 'ROUTE-B' });
  });

  it('a bare shared name with no identity reports ambiguous rather than a picked-first list', async () => {
    const { status, body } = await getJson('/api/terminal/sessions?device=route-shared');
    expect(status).toBe(200);
    expect(body.ambiguous).toBe(true);
    expect(body.sessions).toEqual([]);
  });

  it('a half plane/serial pair 400s honestly instead of silently ignoring the stray param', async () => {
    const { status, body } = await getJson('/api/terminal/sessions?device=route-shared&plane=LOCAL');
    expect(status).toBe(400);
    expect(body.error).toMatch(/together/);
  });

  it('an unrecorded device name answers an honest empty list, not ambiguous', async () => {
    const { status, body } = await getJson('/api/terminal/sessions?device=never-recorded-anywhere');
    expect(status).toBe(200);
    expect(body).toEqual({ sessions: [], ambiguous: false });
  });
});

describe('GET /api/terminal/sessions/:file', () => {
  it('requires ?device= — a bare file name is never enough to read a transcript back', async () => {
    const { status, body } = await getJson('/api/terminal/sessions/route-shared-a.jsonl');
    expect(status).toBe(400);
    expect(body.error).toMatch(/device is required/);
  });

  it('serves the transcript once device+plane+serial resolve to the file\u2019s own identity', async () => {
    const { status, body } = await getJson(
      '/api/terminal/sessions/route-shared-a.jsonl?device=route-shared&plane=LOCAL&serial=ROUTE-A',
    );
    expect(status).toBe(200);
    expect(body.file).toBe('route-shared-a.jsonl');
  });

  it('404s a file that belongs to a different identity under the same shared name — never leaks its content', async () => {
    const { status, body } = await getJson(
      '/api/terminal/sessions/route-shared-b.jsonl?device=route-shared&plane=LOCAL&serial=ROUTE-A',
    );
    expect(status).toBe(404);
    expect(body.error).toMatch(/unknown session recording/);
  });

  it('409s an ambiguous bare-name read instead of serving any transcript', async () => {
    const { status, body } = await getJson('/api/terminal/sessions/route-shared-a.jsonl?device=route-shared');
    expect(status).toBe(409);
    expect(body.error).toMatch(/pass plane and serial/);
  });

  it('rejects a traversal file name', async () => {
    const { status, body } = await getJson(
      '/api/terminal/sessions/..%2Fsettings.json?device=route-shared&plane=LOCAL&serial=ROUTE-A',
    );
    expect(status).toBe(404);
    expect(body.error).toMatch(/unknown session recording/);
  });
});
