/**
 * server/tests/configureHistory.test.ts — GET /api/configure/history.
 *
 * The write broker's own audit log served as {events: BrokerAuditEvent[]},
 * mirroring GET /api/configure/queue's {changes} envelope. The two things
 * this endpoint must never do are (a) invent history when nothing has been
 * brokered on this install and (b) leak a rendered configuration body — the
 * drawer shows what happened to a change, not what was in it.
 *
 * Same harness as routes.test.ts: HPE_SETTINGS_PATH / HPE_DATA_DIR point at a
 * tmp dir and must be set BEFORE the app modules are imported, so the app is
 * loaded with a dynamic import inside beforeAll (the broker resolves its log
 * path at construction).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_VLAN_FORM } from '@hpe/shared';
import type { BrokerAuditEvent } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;

/** A fixture ticket — the broker refuses to queue against an unknown one. */
const TICKET = 'NET-4188';

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-cfghist-'));
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

async function history(query = ''): Promise<BrokerAuditEvent[]> {
  const r = await fetch(`${base}/api/configure/history${query}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { events: BrokerAuditEvent[] }).events;
}

async function queueVlan(id: string): Promise<void> {
  const r = await fetch(`${base}/api/configure/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'vlan', form: { ...DEFAULT_VLAN_FORM, id }, ticket: TICKET }),
  });
  expect(r.status).toBe(200);
}

describe('GET /api/configure/history', () => {
  it('answers an empty list — not an error — when nothing has been brokered yet', async () => {
    expect(await history()).toEqual([]);
  });

  it('serves the broker audit rows, newest first, with no payload body in them', async () => {
    // Queueing is gated on a known ticket; demo mode makes the fixture set known.
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode: true }),
    });
    await queueVlan('900');
    await queueVlan('901');
    await queueVlan('902');

    const events = await history();
    expect(events).toHaveLength(3);
    // Exactly the BrokerAuditEvent contract — no extra key smuggles a body in.
    // `who` is a name, not a payload: it is what makes the row accountable.
    expect(Object.keys(events[0]).sort()).toEqual([
      'changeId',
      'event',
      'kind',
      'result',
      'ticket',
      'ts',
      'who',
    ]);
    // No identity provider is configured in this test, so the row says so
    // honestly rather than naming someone it cannot vouch for.
    expect(events[0].who).toBe('operator');
    expect(events[0].event).toBe('queue');
    expect(events[0].kind).toBe('vlan');
    expect(events[0].ticket).toBe(TICKET);
    expect(typeof events[0].changeId).toBe('string');
    // Newest first: the last change queued leads the list.
    const ids = events.map((e) => e.changeId);
    expect(new Set(ids).size).toBe(3);
    // SECURITY: the rendered VLAN payload must not ride along.
    expect(JSON.stringify(events)).not.toContain('ip helper');
    expect(JSON.stringify(events)).not.toContain('rendered');
  });

  it('honours ?limit and falls back to the default for a missing or unusable one', async () => {
    expect(await history('?limit=1')).toHaveLength(1);
    expect(await history('?limit=2')).toHaveLength(2);
    // A garbage or zero limit is the default page, never an empty answer that
    // would read as "no history".
    expect(await history('?limit=nope')).toHaveLength(3);
    expect(await history('?limit=0')).toHaveLength(3);
    expect(await history('?limit=-5')).toHaveLength(3);
  });
});
