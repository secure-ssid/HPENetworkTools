/**
 * web/src/app/actionDeepLink.ts — consume ?action= deep links from ⌘K.
 *
 * Quick actions land with a one-shot `action` query param. Screens read it
 * into a dismissible cue, then strip it from the URL so refresh does not
 * re-flash the banner and Copy view link stays filter-only.
 */

/** Known palette action ids (query values). */
export type PaletteActionId = 'ticket' | 'silence' | 'diagnostics';

const KNOWN = new Set<string>(['ticket', 'silence', 'diagnostics']);

export function parsePaletteAction(raw: string | null | undefined): PaletteActionId | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!v || !KNOWN.has(v)) return null;
  return v as PaletteActionId;
}

/** Operator-facing copy for the landing cue. */
export function paletteActionCue(action: PaletteActionId): { title: string; body: string } {
  switch (action) {
    case 'ticket':
      return {
        title: 'Raise a ticket',
        body: 'Pick an open alert in the queue, then use Raise ticket. The new ticket keeps the alert’s plane and device evidence.',
      };
    case 'silence':
      return {
        title: 'Silence an alert',
        body: 'Open a firing group from the queue (or stay on Silences to review active hush). Silence needs a reason and an expiry — suppression is never invisible.',
      };
    case 'diagnostics':
      return {
        title: 'Run a diagnostic',
        body: 'Open a device row to reach Active diagnostics (traceroute and reviewed probes). Diagnostics only run against live inventory serials.',
      };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * Drop `action` from a URLSearchParams copy. Returns null when unchanged so
 * callers can skip setSearchParams.
 */
export function stripActionParam(params: URLSearchParams): URLSearchParams | null {
  if (!params.has('action')) return null;
  const next = new URLSearchParams(params);
  next.delete('action');
  return next;
}
