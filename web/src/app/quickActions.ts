/**
 * web/src/app/quickActions.ts — ⌘K operator quick actions.
 *
 * Complements screen jumps: when the operator types "raise ticket", "silence",
 * or "run diagnostic", surface a first-class action hit that deep-links into
 * the right workflow (not just the parent screen).
 */

import type { SearchIndexEntry, View } from '@hpe/shared';
import { normalizeScreenJumpQuery } from './screenJumps';

export type QuickAction = SearchIndexEntry & { path: string };

type ActionDef = {
  id: string;
  /** Primary label shown in the palette. */
  label: string;
  /** Meta line under the label. */
  meta: string;
  /** Destination path including query (shareable deep link). */
  path: string;
  view: View;
  /** Match tokens (lowercase). Exact token or multi-word phrase. */
  tokens: string[];
};

const ACTIONS: ActionDef[] = [
  {
    id: 'raise-ticket',
    label: 'Raise ticket from alert',
    meta: 'Action · open Alerts queue to raise',
    path: '/alerts?tab=queue&action=ticket',
    view: 'alerts',
    tokens: [
      'ticket',
      'tickets',
      'raise ticket',
      'new ticket',
      'open ticket',
      'create ticket',
      'raise',
    ],
  },
  {
    id: 'silence',
    label: 'Silence an alert',
    meta: 'Action · open Silences workflow',
    path: '/alerts?tab=silences&action=silence',
    view: 'alerts',
    tokens: [
      'silence',
      'silences',
      'new silence',
      'hush',
      'mute alert',
      'mute',
      'snooze',
    ],
  },
  {
    id: 'diagnostic',
    label: 'Run device diagnostic',
    meta: 'Action · open Devices to pick a target',
    path: '/devices?action=diagnostics',
    view: 'devices',
    tokens: [
      'diagnostic',
      'diagnostics',
      'run diagnostic',
      'traceroute',
      'trace route',
      'probe',
      'run traceroute',
    ],
  },
];

/**
 * Ranked quick-action hits for a free-text query.
 * Empty / short query → none (palette keeps recent + index preview).
 */
export function matchQuickActions(rawQuery: string, limit = 6): QuickAction[] {
  const q = normalizeScreenJumpQuery(rawQuery);
  if (q.length < 2) return [];

  const scored: Array<{ score: number; action: QuickAction }> = [];

  for (const def of ACTIONS) {
    let score = 0;
    for (const tok of def.tokens) {
      if (tok === q) score = Math.max(score, 100);
      else if (tok.startsWith(q) || q.startsWith(tok)) score = Math.max(score, 80);
      else if (tok.includes(q) || q.includes(tok)) score = Math.max(score, 50);
      else if (q.split(/\s+/).every((part) => tok.includes(part) || def.label.toLowerCase().includes(part))) {
        score = Math.max(score, 35);
      }
    }
    if (score === 0) continue;
    scored.push({
      score,
      action: {
        kind: 'action',
        label: def.label,
        meta: def.meta,
        view: def.view,
        arg: def.id,
        path: def.path,
      },
    });
  }

  scored.sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label));
  return scored.slice(0, limit).map((row) => row.action);
}

/** True when a result is a palette quick action (not an estate/screen hit). */
export function isQuickAction(kind: string | undefined | null): boolean {
  return String(kind ?? '').toLowerCase() === 'action';
}
