/**
 * Auth-events screen routes: envelope, filter/paging list, CSV export.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * GET /auth-events/export is registered before any future /auth-events/:param
 * route so Express does not treat "export" as a param.
 *
 * Honesty: stats/failReasons/policyServices are always computed on the full
 * (unfiltered) feed; only events[] is filtered/paged for the list and export.
 */

import type { Request, Router } from 'express';
import {
  AUTH_EVENTS,
  AUTH_FAIL_REASONS,
  AUTH_STATS,
  POLICY_SERVICES,
  type DeviceRow,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryOneOf, queryString } from '../../lib/query';
import { poller } from '../../services/poller';
import {
  blendFor,
  envelopeFor,
  reportedValue,
  sourceFor,
  withBlended,
} from './context';
import {
  liveAuthStats,
  liveFailReasons,
  livePolicyServices,
} from './authEventsModel';
import { LiveAuthEvent } from './liveCore';
import { applyListFilters, applyListPaging, sendCachedJson } from './listQuery';

/**
 * The Plane column on a live auth row always read CLEARPASS, because the
 * policy plane is the only feed that produces auth events and it truthfully
 * names itself — so the column carried no information at all. The event's
 * `nas` names the switch/controller that asked, and the merged inventory knows
 * which plane owns that device: on a UNIQUE match the row is re-badged with
 * the owning plane, otherwise it keeps the reporter's own label rather than
 * guessing between two devices with the same name.
 *
 * Rows are mapped into new objects — the poller's cached rows are shared by
 * reference with every other reader.
 *
 * Exported for ClearPass screen assembly (same ownership join).
 */
export function withOwningPlane(events: LiveAuthEvent[]): LiveAuthEvent[] {
  const devices = poller.getCache().devices;
  if (devices.length === 0 || events.length === 0) return events;
  const byKey = new Map<string, DeviceRow[]>();
  const note = (key: string | undefined, row: DeviceRow): void => {
    if (!reportedValue(key)) return;
    const k = key!.trim().toLowerCase();
    const rows = byKey.get(k);
    if (rows) rows.push(row);
    else byKey.set(k, [row]);
  };
  for (const row of devices) {
    note(row.name, row);
    note(row.ip, row);
  }
  return events.map((event) => {
    if (!reportedValue(event.nas)) return event;
    const matches = byKey.get(event.nas.trim().toLowerCase());
    if (!matches || matches.length !== 1) return event;
    const owner = matches[0]!;
    return owner.plane === event.plane ? event : { ...event, plane: owner.plane };
  });
}

export function authEventsBody(): Record<string, unknown> {
  if (sourceFor('authEvents') === 'demo') {
    if (blendFor('authEvents')) {
      const events = withOwningPlane(poller.getCache().authEvents as LiveAuthEvent[]);
      if (events.length > 0) {
        return withBlended(
          envelopeFor('authEvents', {
            stats: liveAuthStats(events),
            events,
            failReasons: liveFailReasons(events),
            policyServices: livePolicyServices(events),
          }),
          ['authEvents'],
          'authEvents',
        );
      }
    }
    return envelopeFor('authEvents', {
      stats: AUTH_STATS,
      events: AUTH_EVENTS,
      failReasons: AUTH_FAIL_REASONS,
      policyServices: POLICY_SERVICES,
    });
  }
  const events = withOwningPlane(poller.getCache().authEvents as LiveAuthEvent[]);
  return envelopeFor('authEvents', {
    stats: liveAuthStats(events),
    events,
    failReasons: liveFailReasons(events),
    policyServices: livePolicyServices(events),
  });
}

const AUTH_EVENT_LIST_FIELDS = [
  'who',
  'mac',
  'result',
  'service',
  'method',
  'reason',
  'role',
  'nas',
  'plane',
] as const;

/**
 * Auth-events exact `result` / `service` / `method` / `role` filters (after shared q/plane).
 * Unknown `result` is a no-op (typo cannot empty the log); `service`, `method`,
 * and `role` are case-insensitive exact matches on the row fields.
 */
export function applyAuthEventExactFilters(
  req: Request,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const list = body.events;
  if (!Array.isArray(list)) return body;

  const result =
    queryOneOf(req, 'result', ['accept', 'reject', 'timeout'] as const) ?? '';
  const service = queryString(req, 'service').toLowerCase();
  const method = queryString(req, 'method').toLowerCase();
  const role = queryString(req, 'role').toLowerCase();

  if (!result && !service && !method && !role) return body;

  const filtered = (list as Array<Record<string, unknown>>).filter((row) => {
    if (result && String(row.result ?? '').toLowerCase() !== result) return false;
    if (service && String(row.service ?? '').trim().toLowerCase() !== service) return false;
    if (method && String(row.method ?? '').trim().toLowerCase() !== method) return false;
    if (role && String(row.role ?? '').trim().toLowerCase() !== role) return false;
    return true;
  });
  return { ...body, events: filtered };
}

/** Quick ranges aligned with web TimeRangeControl (`?range=`). */
export const AUTH_EVENT_RANGE_MS = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
} as const;

export type AuthEventRange = keyof typeof AUTH_EVENT_RANGE_MS;

export function parseAuthEventRange(raw: unknown): AuthEventRange | null {
  if (typeof raw !== 'string') return null;
  return queryOneOf({ query: { range: raw } }, 'range', ['15m', '1h', '24h', '7d'] as const);
}

/**
 * Optional `?range=15m|1h|24h|7d` on the auth feed (matches UI TimeRangeControl).
 * 'all' / absent / unknown → no time gate. Rows with missing or unparseable
 * `at` always pass — an undated row cannot be excluded from a window it was
 * never dated against (same honesty as the client control).
 *
 * `nowMs` is injectable for tests; production uses Date.now().
 */
export function applyAuthEventRangeFilter(
  req: { query: Record<string, unknown> },
  body: Record<string, unknown>,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  const list = body.events;
  if (!Array.isArray(list)) return body;
  const range = parseAuthEventRange(req.query.range);
  if (!range) return body;
  const cutoff = nowMs - AUTH_EVENT_RANGE_MS[range];
  const filtered = (list as Array<Record<string, unknown>>).filter((row) => {
    const at = row.at;
    if (typeof at !== 'string' || !at.trim()) return true;
    const ms = new Date(at).getTime();
    if (Number.isNaN(ms)) return true;
    return ms >= cutoff;
  });
  return { ...body, events: filtered };
}

function filterAuthEvents(req: Request, body: Record<string, unknown>) {
  const qPlane = applyListFilters(req, body, 'events', [...AUTH_EVENT_LIST_FIELDS]);
  const exact = applyAuthEventExactFilters(req, qPlane);
  return applyAuthEventRangeFilter(req, exact);
}

export function registerAuthEventsRoutes(router: Router): void {
  /**
   * GET /api/auth-events/export — CSV of auth events
   * (optional q/plane/result/service/method/role/range). Stats omitted.
   */
  router.get('/auth-events/export', (req, res) => {
    const body = authEventsBody();
    const filtered = filterAuthEvents(req, body);
    const rows = (filtered.events as Array<Record<string, unknown>>) ?? [];
    sendCsv(
      res,
      'auth-events.csv',
      ['time', 'at', 'who', 'mac', 'result', 'service', 'method', 'role', 'reason', 'nas', 'plane'],
      rows.map((e) => [
        e.time,
        e.at ?? '',
        e.who,
        e.mac,
        e.result,
        e.service,
        e.method,
        e.role,
        e.reason,
        e.nas,
        e.plane,
      ]),
    );
  });

  router.get('/auth-events', (req, res) => {
    const body = authEventsBody();
    // Filter then page events; stats/failReasons stay computed on the full set.
    const filtered = filterAuthEvents(req, body);
    const paged = applyListPaging(req, filtered, 'events');
    if ('error' in paged) {
      res.status(400).json({ error: paged.error, code: 'AUTH_EVENTS_PAGING' });
      return;
    }
    sendCachedJson(req, res, paged.body);
  });
}
