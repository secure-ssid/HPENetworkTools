/** Terminal session listing and recorded transcripts. */

import { fromStrictOptionalApi } from './core';
import { DeviceDetailIdentity } from './screens';

// ---------------------------------------------------------------------------
// Terminal sessions — recorded shells (data/shell-logs)
// ---------------------------------------------------------------------------

export interface TerminalSession {
  file: string;
  device: string;
  user: string;
  target: string;
  openedAt: string;
  /** Plane+serial this recording was opened against, when the session
   *  carried a complete identity pair — absent for a legacy recording or one
   *  opened without one. Mirrors server SessionInfo (services/terminal.ts). */
  plane?: string;
  serial?: string;
}

/**
 * Recorded sessions for one device, scoped to the exact plane+serial pair
 * when supplied (see server services/terminal.ts listSessionsForDevice) —
 * [] when none or backend absent. When the display name still names more
 * than one physical device without an exact identity, the server answers
 * `ambiguous: true` rather than guessing a match; that is surfaced as a
 * thrown error so the caller's existing failure path renders a reason
 * instead of a misleadingly empty "no sessions on file".
 */
export async function getTerminalSessions(
  device: string,
  identity: DeviceDetailIdentity = {},
): Promise<TerminalSession[]> {
  const params = new URLSearchParams({ device });
  if (identity.plane) params.set('plane', identity.plane);
  if (identity.serial) params.set('serial', identity.serial);
  const r = await fromStrictOptionalApi<{ sessions: TerminalSession[]; ambiguous?: boolean }>(
    `/api/terminal/sessions?${params.toString()}`,
  );
  if (!r) return [];
  if (r.ambiguous) {
    throw new Error(
      `'${device}' names more than one device — recorded sessions need an exact plane and serial to show safely`,
    );
  }
  return r.sessions;
}

export interface TerminalSessionEvent {
  type: 'open' | 'in' | 'out' | 'blocked' | 'close';
  at: string;
  text?: string;
  reason?: string;
}

export interface TerminalTranscript {
  file: string;
  events: TerminalSessionEvent[];
  truncated: boolean;
}

/** One recorded transcript, gated by the same device+identity the listing
 *  used to name it — a bare file name is never enough on its own (it would
 *  let a caller that merely knows another device's file name read a
 *  transcript that does not belong to it). Null when unknown, ambiguous, or
 *  the backend is absent. */
export async function getTerminalSession(
  file: string,
  device: string,
  identity: DeviceDetailIdentity = {},
): Promise<TerminalTranscript | null> {
  const params = new URLSearchParams({ device });
  if (identity.plane) params.set('plane', identity.plane);
  if (identity.serial) params.set('serial', identity.serial);
  return fromStrictOptionalApi<TerminalTranscript>(
    `/api/terminal/sessions/${encodeURIComponent(file)}?${params.toString()}`,
    true,
  );
}
