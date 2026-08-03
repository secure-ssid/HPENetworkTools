/**
 * server/src/services/notificationCenter.ts — the in-app notification center
 * (the bell).
 *
 * Entries (shared/alertRules.ts NotificationCenterEntry) persist to
 * data/notification-center.json — the silence store's own pattern: atomic
 * write, 0600, HPE_DATA_DIR override for tests — as a capped list
 * (NOTIFICATION_CENTER_CAPACITY). This is a feed, not an archive: the change
 * log is the archive, the bell keeps the recent, actionable tail.
 *
 * The center is SINGLE-OPERATOR: one global read flag per entry, no per-user
 * state. The portal's own auth model is all-or-nothing (one operator
 * identity, or none), so per-principal read state would be bookkeeping for a
 * distinction the portal does not make anywhere else.
 *
 * Failure degrades to EMPTY, never to an exception: an unreadable file reads
 * as no entries, and a failed write is a console line, not a 500 — the bell
 * is a convenience surface, and the engine firing into it must never be taken
 * down by the store it feeds.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  NOTIFICATION_CENTER_CAPACITY,
  NOTIFICATION_CENTER_PAGE,
  type NotificationCenterEntry,
  type NotificationCenterSeverity,
  type NotificationCenterView,
} from '@hpe/shared';
import { brokerDataDir } from './writeBroker';

/** What a push needs — the store stamps id/createdAt/read. */
export interface NotificationCenterInput {
  title: string;
  body: string;
  severity: NotificationCenterSeverity;
  deviceSerial?: string;
  url?: string;
  demo?: boolean;
}

export class NotificationCenterStore {
  private entries: NotificationCenterEntry[] | null = null;

  constructor(private readonly dataDir: string = process.env.HPE_DATA_DIR ?? brokerDataDir()) {}

  private get file(): string {
    return path.join(this.dataDir, 'notification-center.json');
  }

  /** Rows exactly as persisted — the basis for every mutation and write. On
   *  any read failure the center is EMPTY (see the header), and the next save
   *  starts a fresh file. */
  private stored(): NotificationCenterEntry[] {
    if (this.entries !== null) return this.entries.map((e) => ({ ...e }));
    this.entries = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.entries = parsed as NotificationCenterEntry[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`notification center: unreadable store, starting empty: ${(err as Error).message}`);
      }
    }
    return this.stored();
  }

  /** The newest page plus the global unread count — the bell's whole view. */
  list(limit: number = NOTIFICATION_CENTER_PAGE): NotificationCenterView {
    const all = this.stored();
    return { entries: all.slice(0, limit), unread: all.filter((e) => !e.read).length };
  }

  /** Append one entry, newest-first, capped. Never throws (see the header):
   *  the entry is returned either way, and a failed write is logged. */
  push(input: NotificationCenterInput, now: number = Date.now()): NotificationCenterEntry {
    const entry: NotificationCenterEntry = {
      id: `nce-${new Date(now).getTime().toString(36)}${randomBytes(3).toString('hex')}`,
      title: input.title,
      body: input.body,
      severity: input.severity,
      ...(input.deviceSerial ? { deviceSerial: input.deviceSerial } : {}),
      ...(input.url ? { url: input.url } : {}),
      createdAt: new Date(now).toISOString(),
      read: false,
      ...(input.demo ? { demo: true } : {}),
    };
    this.save([entry, ...this.stored()].slice(0, NOTIFICATION_CENTER_CAPACITY));
    return entry;
  }

  /** Mark entries read. Returns the new unread count. Unknown ids are
   *  ignored — a bell that raced a trim is not an error worth a 404. */
  markRead(ids: readonly string[]): number {
    const wanted = new Set(ids);
    let changed = false;
    const entries = this.stored().map((e) => {
      if (!e.read && wanted.has(e.id)) {
        changed = true;
        return { ...e, read: true };
      }
      return e;
    });
    if (changed) this.save(entries);
    return entries.filter((e) => !e.read).length;
  }

  /** Mark everything read. Returns the new unread count — 0, but computed
   *  rather than assumed if the semantics ever grow a per-user split. A
   *  no-op click writes nothing. */
  markAllRead(): number {
    const current = this.stored();
    if (current.every((e) => e.read)) return 0;
    const entries = current.map((e) => ({ ...e, read: true }));
    this.save(entries);
    return entries.filter((e) => !e.read).length;
  }

  private save(entries: NotificationCenterEntry[]): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
      this.entries = entries;
    } catch (err) {
      // Degrade, never throw: the bell is a convenience surface, and the
      // engine writing into it must not go down with its store.
      console.error(`notification center: store write failed: ${(err as Error).message}`);
    }
  }
}

export const notificationCenter = new NotificationCenterStore();
