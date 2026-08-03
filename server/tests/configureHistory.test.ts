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
import { DEFAULT_SSID_FORM } from '@hpe/shared';
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

async function queueChange(id: string): Promise<void> {
  const r = await fetch(`${base}/api/configure/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // History behavior is kind-agnostic. Use the broker's retained legacy SSID
    // queue shape so this audit-route test does not forge a configured VLAN
    // identity that the authoritative Central inventory never reported.
    body: JSON.stringify({ kind: 'ssid', form: { ...DEFAULT_SSID_FORM, name: `history-${id}` }, ticket: TICKET }),
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
    await queueChange('900');
    await queueChange('901');
    await queueChange('902');

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
    expect(events[0].kind).toBe('ssid');
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

/**
 * The envelope has to distinguish "nothing was brokered" from "part of the
 * record is unreachable". Both come back as a short list of events; only
 * `unreadable` tells them apart, and the drawer renders a warning on it.
 */
describe('GET /api/configure/history — partial reads', () => {
  it('states that nothing was unreadable when the log opened cleanly', async () => {
    const r = await fetch(`${base}/api/configure/history?limit=5`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { events: unknown[]; unreadable: string[] };
    // Present and empty, not absent: the server is making the claim, so an
    // older client that ignores the field is not silently reassured by it.
    expect(Array.isArray(body.unreadable)).toBe(true);
    expect(body.unreadable).toEqual([]);
  });

  it('names a rotated generation it could not open', async () => {
    const { mkdirSync, rmSync: rm } = await import('node:fs');
    // The broker resolves change-log.jsonl under the data dir; .1 is the first
    // rotated generation. A directory there fails the read the way a bad
    // permission or a bad sector would.
    const gen = join(tmpDir, 'data', 'change-log.1.jsonl');
    mkdirSync(gen, { recursive: true });
    try {
      const r = await fetch(`${base}/api/configure/history?limit=50`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { events: unknown[]; unreadable: string[] };
      expect(body.unreadable).toEqual(['change-log.1.jsonl']);
      // Still a 200 with the readable rows: a partial audit log is worth
      // showing, it just must not claim to be the whole of it.
      expect(Array.isArray(body.events)).toBe(true);
    } finally {
      rm(gen, { recursive: true, force: true });
    }
  });
});
