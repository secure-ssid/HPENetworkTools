/**
 * server/tests/alertTimeline.test.ts — the per-group occurrence timeline.
 *
 * Same harness as silences.test.ts: env vars point at a tmp dir before any
 * src/ module is imported. The portal runs in demo mode, so the queue is the
 * authored fixtures (the tunnel-flap group fires ×3; the flapping AP carries
 * the authored demo spine) — and every store fact the join reads is created
 * here against the tmp data dir.
 *
 * Covered:
 *   - a firing group serves a fired event with an APPROXIMATE time (age
 *     strings are not clock readings);
 *   - silences from the store appear with their reason, expired ones included;
 *   - the device's change-log lines appear as change events, silence-audit
 *     and config-backup lines excluded (their own stores tell those stories);
 *   - config-backup drift appears as drift events;
 *   - the ONE correlation sentence fires when firings follow a change within
 *     30m — and never claims cause;
 *   - the demo AP fingerprint carries the authored spine, labelled;
 *   - an unknown fingerprint with no facts anywhere answers 404.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlertTimeline } from '@hpe/shared';
import { DEMO_TIMELINE_FINGERPRINT, alertFingerprint } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let appendBrokerLog: typeof import('../src/services/writeBroker').appendBrokerLog;
let silenceStore: typeof import('../src/services/silences').silenceStore;
let configBackups: typeof import('../src/services/configBackup').configBackups;

const FLAP_FP = alertFingerprint({ plane: 'AOS-10', device: 'gw-edge-1', title: 'gw-edge-1 tunnel flap ×14 in an hour' });

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-timeline-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ appendBrokerLog } = await import('../src/services/writeBroker'));
  ({ silenceStore } = await import('../src/services/silences'));
  ({ configBackups } = await import('../src/services/configBackup'));
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

async function timeline(fp: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/alerts/${encodeURIComponent(fp)}/timeline`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('the occurrence timeline', () => {
  it('serves a fired event for a firing group, time marked approximate', async () => {
    const { status, body } = await timeline(FLAP_FP);
    expect(status).toBe(200);
    const t = body.timeline as AlertTimeline;
    expect(t.fingerprint).toBe(FLAP_FP);
    expect(t.device).toBe('gw-edge-1');
    const fired = t.events.filter((e) => e.kind === 'fired');
    expect(fired).toHaveLength(1);
    expect(fired[0].label).toContain('Fired ×3');
    expect(fired[0].label).toContain('first seen 55m ago');
    expect(fired[0].approximate).toBe(true);
    // Oldest first.
    const times = t.events.map((e) => Date.parse(e.ts));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('joins silences, change-log lines and drift for the group’s device', async () => {
    // A silence (store fact)…
    silenceStore.create({ device: 'gw-edge-1', reason: 'tunnel rekey work', durationMinutes: 480 });
    // …a brokered change naming the device (change-log fact)…
    appendBrokerLog(join(tmpDir, 'data'), {
      ts: new Date(Date.now() - 40 * 60_000).toISOString(),
      event: 'push',
      changeId: 'chg-test-1',
      ticket: 'NET-1',
      kind: 'ssid',
      result: 'ssid profile push to campus-01',
      device: 'gw-edge-1',
    });
    // …and two config versions, the second a drift (backup-service fact).
    configBackups.recordSnapshot('gw-edge-1', 'hostname gw-edge-1\nntp 10.0.0.1', 'test', new Date(Date.now() - 50 * 60_000).toISOString());
    configBackups.recordSnapshot('gw-edge-1', 'hostname gw-edge-1\nntp 10.0.0.2', 'test', new Date(Date.now() - 45 * 60_000).toISOString());

    const { status, body } = await timeline(FLAP_FP);
    expect(status).toBe(200);
    const t = body.timeline as AlertTimeline;

    const silenced = t.events.filter((e) => e.kind === 'silenced');
    expect(silenced.some((e) => e.label.includes('tunnel rekey work'))).toBe(true);

    const changes = t.events.filter((e) => e.kind === 'change');
    expect(changes.some((e) => e.label.includes('ssid profile push'))).toBe(true);
    // The silence's own audit line and the backup's audit line are NOT change
    // events — the silence store and the backup service tell those stories.
    expect(changes.every((e) => !e.label.includes('alert-silence'))).toBe(true);
    expect(changes.every((e) => !e.label.includes('config-backup'))).toBe(true);

    const drift = t.events.filter((e) => e.kind === 'config-drift');
    expect(drift).toHaveLength(1);
    expect(drift[0].label).toContain('v2');

    // The ONE sanctioned sentence: the 38m and 12m firings fall within 30m
    // after the change 40m ago; the 55m one does not.
    expect(t.correlation).toBe('2 alerts fired within 30m after change chg-test-1 — a correlation in time, not a proven cause');
  });

  it('a silence expiry appears as its own event', async () => {
    const expiredFp = alertFingerprint({ plane: 'MIST', device: 'ap-old-1', title: 'some old alert' });
    silenceStore.create({ device: 'ap-old-1', reason: 'long over', durationMinutes: 1 }, Date.now() - 120_000);
    const { status, body } = await timeline(expiredFp);
    expect(status).toBe(200); // no group firing — the silence alone carries it
    const t = body.timeline as AlertTimeline;
    expect(t.events.some((e) => e.kind === 'silenced' && e.label.includes('long over'))).toBe(true);
    expect(t.events.some((e) => e.kind === 'silence-expired' && e.label.includes('long over'))).toBe(true);
  });

  it('the demo AP fingerprint carries the authored spine, labelled', async () => {
    const { status, body } = await timeline(DEMO_TIMELINE_FINGERPRINT);
    expect(status).toBe(200);
    const t = body.timeline as AlertTimeline;
    expect(t.events.some((e) => e.kind === 'silenced' && (e.detail ?? '').includes('mw-demo-ap3f'))).toBe(true);
    expect(t.events.some((e) => (e.detail ?? '').includes('demo fixture'))).toBe(true);
    expect(t.correlation).toContain('within 30m after change');
    expect(t.correlation).toContain('not a proven cause');
  });

  it('404s an unknown fingerprint nothing has ever seen', async () => {
    const { status, body } = await timeline('nowhere|no-device|no such title');
    expect(status).toBe(404);
    expect(String(body.error)).toContain('unknown alert fingerprint');
  });
});
