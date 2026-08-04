/**
 * web/src/app/screenJumps.ts — ⌘K "go to screen" matches from NAV_GROUPS.
 *
 * Pure helpers so SearchPanel can surface screen destinations above estate
 * hits when the operator types a screen name ("alerts", "go licences").
 */

import { NAV_GROUPS } from '@hpe/shared';
import type { SearchIndexEntry, View } from '@hpe/shared';
import { pathForView } from './nav';

export type ScreenJump = SearchIndexEntry & { path: string };

/** Strip "go "/"goto "/"open " prefixes operators type out of habit. */
export function normalizeScreenJumpQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(go\s+to|goto|go|open)\s+/i, '')
    .trim();
}

/** Alias tokens → view for common short forms not identical to the label. */
const ALIASES: Record<string, View> = {
  auth: 'auth',
  'auth events': 'auth',
  authevents: 'auth',
  licence: 'licenses',
  licences: 'licenses',
  license: 'licenses',
  licenses: 'licenses',
  recs: 'recommendations',
  recommendation: 'recommendations',
  recommendations: 'recommendations',
  systems: 'systems',
  connected: 'systems',
  'connected systems': 'systems',
  inventory: 'inventory',
  explorer: 'inventory',
  gl: 'greenlake',
  greenlake: 'greenlake',
  overview: 'overview',
  home: 'overview',
  ops: 'overview',
  operations: 'overview',
};

type ScreenDef = { label: string; view: View; group: string };

function allScreens(): ScreenDef[] {
  const out: ScreenDef[] = [];
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      out.push({ label: item.label, view: item.view, group: group.label });
    }
  }
  return out;
}

/**
 * Ranked screen jump hits for a free-text query.
 * Empty query → no jumps (empty panel keeps recent + index preview).
 * Requires at least 2 characters after optional go/open prefix.
 */
export function matchScreenJumps(rawQuery: string, limit = 6): ScreenJump[] {
  const q = normalizeScreenJumpQuery(rawQuery);
  if (q.length < 2) return [];

  const aliasView = ALIASES[q];
  const screens = allScreens();
  const scored: Array<{ score: number; jump: ScreenJump }> = [];

  for (const s of screens) {
    const label = s.label.toLowerCase();
    const view = String(s.view).toLowerCase();
    let score = 0;
    if (aliasView && s.view === aliasView) score = 100;
    else if (label === q || view === q) score = 90;
    else if (label.startsWith(q) || view.startsWith(q)) score = 70;
    else if (label.includes(q) || view.includes(q)) score = 40;
    else if (q.split(/\s+/).every((tok) => label.includes(tok) || view.includes(tok))) score = 30;
    if (score === 0) continue;
    scored.push({
      score,
      jump: {
        kind: 'screen',
        label: s.label,
        meta: `Go to · ${s.group}`,
        view: s.view,
        arg: null,
        path: pathForView(s.view),
      },
    });
  }

  scored.sort((a, b) => b.score - a.score || a.jump.label.localeCompare(b.jump.label));
  const seen = new Set<string>();
  const out: ScreenJump[] = [];
  for (const row of scored) {
    const key = row.jump.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.jump);
    if (out.length >= limit) break;
  }
  return out;
}
