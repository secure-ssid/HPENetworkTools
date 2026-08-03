/**
 * server/tests/notificationCenter.test.ts — the in-app notification center
 * (the bell): its store and its routes.
 *
 * HPE_SETTINGS_PATH / HPE_DATA_DIR point at a tmp dir so the test never
 * touches real data/ — the same harness silences.test.ts uses.
 *
 * Covered:
 *   store  — empty start, persistence across instances, 0600, newest-first
 *            with the capacity cap, unread counting, markRead ignoring
 *            unknown ids (a bell that raced a trim is not a 404), markAllRead,
 *            corrupt file reads as EMPTY (degrade, never throw);
 *   routes — GET /api/notifications/center serves the newest 15 plus the
 *            unread count; POST mark-read takes {ids} or {all}, returns the
 *            server's own new unread count, and refuses everything else.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTIFICATION_CENTER_CAPACITY, NOTIFICATION_CENTER_PAGE } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let NotificationCenterStore: typeof import('../src/services/notificationCenter').NotificationCenterStore;
let notificationCenter: typeof import('../src/services/notificationCenter').notificationCenter;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-ntc-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const mod = await import('../src/services/notificationCenter');
  NotificationCenterStore = mod.NotificationCenterStore;
  notificationCenter = mod.notificationCenter;
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

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function sendJson(method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('NotificationCenterStore', () => {
  it('starts empty and persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntc-store-'));
    try {
      const store = new NotificationCenterStore(dir);
      expect(store.list()).toEqual({ entries: [], unread: 0 });
      const entry = store.push({ title: 'ap-1f-04 offline', body: 'offline 5m', severity: 'danger' }, Date.parse('2026-08-01T00:00:00.000Z'));
      expect(entry.id).toMatch(/^nce-/);
      expect(entry.read).toBe(false);
      const reloaded = new NotificationCenterStore(dir);
      expect(reloaded.list().entries).toHaveLength(1);
      expect(reloaded.list().unread).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the store file with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntc-store-'));
    try {
      new NotificationCenterStore(dir).push({ title: 'x', body: 'y', severity: 'info' });
      expect(statSync(join(dir, 'notification-center.json')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps newest first and caps the feed at the capacity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntc-store-'));
    try {
      const store = new NotificationCenterStore(dir);
      for (let i = 0; i < NOTIFICATION_CENTER_CAPACITY + 10; i += 1) {
        store.push({ title: `entry ${i}`, body: 'x', severity: 'warning' }, i);
      }
      const all = store.list(NOTIFICATION_CENTER_CAPACITY + 10);
      expect(all.entries).toHaveLength(NOTIFICATION_CENTER_CAPACITY);
      expect(all.entries[0]!.title).toBe(`entry ${NOTIFICATION_CENTER_CAPACITY + 9}`);
      expect(all.unread).toBe(NOTIFICATION_CENTER_CAPACITY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks specific ids read, ignores unknown ids, and marks all read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntc-store-'));
    try {
      const store = new NotificationCenterStore(dir);
      const a = store.push({ title: 'a', body: 'x', severity: 'danger' });
      const b = store.push({ title: 'b', body: 'x', severity: 'success' });
      store.push({ title: 'c', body: 'x', severity: 'info' });
      expect(store.markRead([a.id, 'nce-unknown'])).toBe(2);
      expect(store.list().entries.find((e) => e.id === a.id)!.read).toBe(true);
      expect(store.list().entries.find((e) => e.id === b.id)!.read).toBe(false);
      expect(store.markAllRead()).toBe(0);
      expect(store.list().unread).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a corrupt file as empty rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntc-store-'));
    try {
      writeFileSync(join(dir, 'notification-center.json'), '{broken');
      const store = new NotificationCenterStore(dir);
      expect(store.list()).toEqual({ entries: [], unread: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('notification center routes', () => {
  it('GET serves the newest page plus the unread count', async () => {
    notificationCenter.markAllRead();
    for (let i = 0; i < NOTIFICATION_CENTER_PAGE + 3; i += 1) {
      notificationCenter.push({ title: `bell ${i}`, body: 'x', severity: 'warning' }, i);
    }
    notificationCenter.markAllRead();
    notificationCenter.push({ title: 'bell unread', body: 'x', severity: 'danger' });
    const { status, body } = await getJson('/api/notifications/center');
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(NOTIFICATION_CENTER_PAGE);
    expect(body.entries[0].title).toBe('bell unread');
    expect(body.unread).toBe(1);
    notificationCenter.markAllRead();
  });

  it('POST mark-read takes specific ids and returns the new unread count', async () => {
    notificationCenter.markAllRead();
    const a = notificationCenter.push({ title: 'mark a', body: 'x', severity: 'danger' });
    notificationCenter.push({ title: 'mark b', body: 'x', severity: 'info' });
    const { status, body } = await sendJson('POST', '/api/notifications/center/mark-read', { ids: [a.id] });
    expect(status).toBe(200);
    expect(body.unread).toBe(1);
    const all = await sendJson('POST', '/api/notifications/center/mark-read', { all: true });
    expect(all.status).toBe(200);
    expect(all.body.unread).toBe(0);
  });

  it('POST mark-read refuses ambiguous bodies', async () => {
    for (const payload of [{}, { ids: [] }, { ids: ['x', 1] }, { all: 'yes' }]) {
      const { status, body } = await sendJson('POST', '/api/notifications/center/mark-read', payload);
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
    }
  });
});
