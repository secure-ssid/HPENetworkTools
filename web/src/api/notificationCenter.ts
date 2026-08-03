/** The in-app notification center (the bell) — entries the server-side
 *  engines write when something deserves the operator's attention. */

import { apiFetch } from './core';
import { type NotificationCenterView } from '@hpe/shared';

type Err = { error: string; offline?: boolean };

/** GET /api/notifications/center — the newest page plus the unread count. */
export async function getNotificationCenter(): Promise<NotificationCenterView | Err> {
  try {
    const r = await apiFetch('/api/notifications/center');
    const body = (await r.json().catch(() => ({}))) as Partial<NotificationCenterView> & { error?: string };
    if (r.ok && Array.isArray(body.entries) && typeof body.unread === 'number') {
      return { entries: body.entries, unread: body.unread };
    }
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** POST /api/notifications/center/mark-read — specific ids, or everything.
 *  Returns the server's own new unread count. */
export async function markNotificationCenterRead(
  input: { ids: string[] } | { all: true },
): Promise<{ unread: number } | Err> {
  try {
    const r = await apiFetch('/api/notifications/center/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await r.json().catch(() => ({}))) as { unread?: number; error?: string };
    if (r.ok && typeof body.unread === 'number') return { unread: body.unread };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}
