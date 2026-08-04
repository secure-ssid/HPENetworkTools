/**
 * Connected systems screen view-model route.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Live connector state / credentials remain on routes/systems.ts
 * (/api/systems/state, credentials, test, …). This module only serves the
 * screen envelope: systems rows + syncHistory + permissions, plus the
 * roster CSV export (no credentials / secrets).
 *
 * GET /systems and GET /systems/export are static paths (export registered
 * first so it never collides with a future /systems/:param sibling).
 */

import type { Request, Router } from 'express';
import { PERMISSIONS, SYNC_HISTORY, SYSTEMS } from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryFlag, queryOneOf, queryString } from '../../lib/query';
import { registry } from '../../planes/registry';
import { PLANE_IDS } from '../../planes/types';
import {
  blendFor,
  envelopeFor,
  sourceFor,
  withBlended,
} from './context';
import { liveSyncHistory, liveSystemRows } from './systemsModel';

const SYSTEMS_HEALTH = ['healthy', 'warning', 'degraded', 'unlinked'] as const;

/** Systems screen envelope body (demo / blend / live). */
export function systemsBody(): Record<string, unknown> {
  const states = registry.states();
  // Blend mode: once any plane is actually linked, the fixture systems list
  // would LIE (it shows a healthy demo Central with 164 devices) — swap the
  // whole section to the live registry rows, same rule as every other
  // section. A 'demo' pin defeats the swap (blendFor); a 'live' pin serves
  // the registry rows even with nothing linked.
  if (sourceFor('systems') === 'demo') {
    if (blendFor('systems') && PLANE_IDS.some((id) => states[id].linked)) {
      const payload = {
        systems: liveSystemRows(states),
        syncHistory: liveSyncHistory(),
        permissions: PERMISSIONS,
      };
      return withBlended(envelopeFor('systems', payload), ['systems'], 'systems');
    }
    return envelopeFor('systems', {
      systems: SYSTEMS,
      syncHistory: SYNC_HISTORY,
      permissions: PERMISSIONS,
    });
  }
  return envelopeFor('systems', {
    systems: liveSystemRows(states),
    syncHistory: liveSyncHistory(),
    permissions: PERMISSIONS,
  });
}

type SystemExportRow = {
  name?: unknown;
  planeId?: unknown;
  kind?: unknown;
  state?: unknown;
  scope?: unknown;
  facts?: Array<{ k?: unknown; v?: unknown }> | unknown;
};

/** Pull a fact value by case-insensitive key prefix (e.g. "Last sync", "Devices"). */
function factValue(row: SystemExportRow, needle: string): string {
  const facts = Array.isArray(row.facts) ? row.facts : [];
  const n = needle.toLowerCase();
  for (const f of facts) {
    if (!f || typeof f !== 'object') continue;
    const k = String((f as { k?: unknown }).k ?? '')
      .trim()
      .toLowerCase();
    if (k === n || k.startsWith(n)) {
      return String((f as { v?: unknown }).v ?? '');
    }
  }
  return '';
}

/**
 * Optional health / linked / q filters for the systems roster CSV.
 * Loop 118: shared queryString / queryOneOf / queryFlag.
 * Unknown health values are ignored (honest no-op) rather than inventing
 * an empty export from a typo. `linked` accepts the full queryFlag vocabulary
 * (`1`/`true`/`yes`/`on` | `0`/`false`/`no`/`off`).
 */
export function applySystemsRosterFilters(
  req: { query: Record<string, unknown> },
  rows: SystemExportRow[],
): SystemExportRow[] {
  const wantHealth = queryOneOf(req, 'health', SYSTEMS_HEALTH) ?? '';
  const wantLinked = queryFlag(req, 'linked');
  const q = queryString(req, 'q').toLowerCase();

  if (!wantHealth && wantLinked === null && !q) return rows;

  return rows.filter((row) => {
    const health = String(row.state ?? '')
      .trim()
      .toLowerCase();
    const linked = health !== '' && health !== 'unlinked';
    if (wantHealth && health !== wantHealth) return false;
    if (wantLinked === true && !linked) return false;
    if (wantLinked === false && linked) return false;
    if (q) {
      const hay = [row.name, row.planeId, row.kind, row.state, row.scope]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function registerSystemsRoutes(router: Router): void {
  /**
   * GET /api/systems/export — CSV of the connected-systems roster.
   * Summary fields only (name/planeId/kind/health/scope/sync/counts). Never
   * credentials, tokens, recent call paths, or free-text notes.
   * Optional `q=` / `health=` / `linked=` (queryFlag: 1/true/yes/on | 0/false/no/off)
   * match operator triage filters.
   * Registered before GET /systems so a future :param sibling cannot shadow it.
   */
  router.get('/systems/export', (req: Request, res) => {
    const body = systemsBody();
    const list = Array.isArray(body.systems) ? (body.systems as SystemExportRow[]) : [];
    const rows = applySystemsRosterFilters(req, list);
    sendCsv(
      res,
      'systems-roster.csv',
      ['name', 'planeId', 'kind', 'health', 'linked', 'scope', 'lastSync', 'devices', 'callsToday'],
      rows.map((r) => {
        const health = String(r.state ?? '');
        const linked = health && health.toLowerCase() !== 'unlinked' ? 'true' : 'false';
        return [
          r.name ?? '',
          r.planeId ?? '',
          r.kind ?? '',
          health,
          linked,
          r.scope ?? '',
          factValue(r, 'last sync'),
          factValue(r, 'device'),
          factValue(r, 'calls'),
        ];
      }),
    );
  });

  /** GET /api/systems — connected systems screen view model. */
  router.get('/systems', (_req, res) => {
    res.json(systemsBody());
  });
}
