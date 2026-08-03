/** Alert silences — time-boxed suppression of alert groups (Alertmanager model). */

import { apiFetch } from './core';
import { type AlertSilence } from '@hpe/shared';

/** What a silence create needs; the server stamps id/createdAt/until. */
export interface SilenceInput {
  plane?: string;
  device?: string;
  titleContains?: string;
  reason: string;
  durationMinutes: number;
}

/** GET /api/silences — every silence on file, expired ones flagged. */
export async function getSilences(): Promise<{ silences: AlertSilence[] } | { error: string; offline?: boolean }> {
  try {
    const r = await apiFetch('/api/silences');
    const body = (await r.json().catch(() => ({}))) as { silences?: AlertSilence[]; error?: string };
    if (r.ok && body.silences) return { silences: body.silences };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** POST /api/silences — create a time-boxed silence (audit-logged server-side). */
export async function createSilence(input: SilenceInput): Promise<{ silence: AlertSilence } | { error: string; offline?: boolean }> {
  try {
    const r = await apiFetch('/api/silences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await r.json().catch(() => ({}))) as { silence?: AlertSilence; error?: string };
    if (r.ok && body.silence) return { silence: body.silence };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** DELETE /api/silences/:id — unsilence (audit-logged server-side). */
export async function deleteSilence(id: string): Promise<{ ok: true } | { error: string; offline?: boolean }> {
  try {
    const r = await apiFetch(`/api/silences/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (r.ok && body.ok) return { ok: true };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}
