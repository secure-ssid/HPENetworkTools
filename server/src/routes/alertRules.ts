/**
 * server/src/routes/alertRules.ts — device-down rule CRUD + the notification
 * center (the bell).
 *
 *   GET    /api/alert-rules                        every rule on file (optional enabled=/deviceType=)
 *   GET    /api/alert-rules/export                 CSV of rules on file (optional enabled=/deviceType=; no secrets)
 *   POST   /api/alert-rules                        {enabled?, siteFilter?, deviceTypeFilter?, offlineMinutes?, cooldownMinutes?} → 201
 *   PUT    /api/alert-rules/:id                    partial edit → 200 | 404
 *   DELETE /api/alert-rules/:id                    remove → {ok, rule} | 404
 *
 *   GET    /api/notifications/center               newest 15 entries + unread count
 *   POST   /api/notifications/center/mark-read     {ids: string[]} | {all: true} → {unread}
 *
 * Rules are NOT brokered writes — nothing is pushed to a plane — so there is
 * no ticket gate; but every mutation is an operator action and is
 * audit-logged through the same append-only change log as the silences
 * (services/writeBroker.ts appendBrokerLog, ticket '—').
 *
 * Validation refuses rather than repairs, the repo's rule: minutes fields are
 * whole numbers 1–1440, the type filter must normalize into the
 * all/switch/ap/gateway vocabulary (aliases accepted, nonsense rejected with
 * the vocabulary named), and a provided-but-empty site filter is a 400 with
 * the instruction to omit it — never a silent rewrite of what the operator
 * meant.
 */

import { Router } from 'express';
import {
  normalizeDeviceTypeFilter,
  validateDeviceDownRule,
  type DeviceDownRuleInput,
  type DeviceTypeFilter,
} from '@hpe/shared';
import { h } from './handler';
import { sendCsv } from '../lib/csv';
import { queryFlag, queryString } from '../lib/query';
import { alertRuleStore, logAlertRuleEvent } from '../services/alertRules';
import { notificationCenter } from '../services/notificationCenter';
import { brokerDataDir } from '../services/writeBroker';

export const alertRulesRouter = Router();
export const notificationCenterRouter = Router();

/**
 * Optional list/export filters for device-down rules (Policy tab + CSV):
 *   `?enabled=0|1|true|false`
 *   `?deviceType=` — canonical or alias vocabulary (switch/ap/gateway/all);
 *     unknown tokens are an honest no-op (never coerce to 'all')
 * Absent / unrecognised → every rule on file (backward compatible).
 */
export function filterAlertRulesByEnabled<T extends {
  enabled: boolean;
  deviceTypeFilter?: DeviceTypeFilter | string | null;
}>(
  req: { query: Record<string, unknown> },
  rules: T[],
): T[] {
  let out = rules;
  const enabled = queryFlag(req, 'enabled');
  if (enabled === true) out = out.filter((r) => r.enabled);
  else if (enabled === false) out = out.filter((r) => !r.enabled);

  const typeRaw = queryString(req, 'deviceType');
  if (typeRaw) {
    const want = normalizeDeviceTypeFilter(typeRaw);
    if (want) {
      out = out.filter((r) => {
        const have = (r.deviceTypeFilter ?? 'all') as string;
        // 'all' query matches every rule; otherwise exact canonical type.
        if (want === 'all') return true;
        return have === want;
      });
    }
  }
  return out;
}

alertRulesRouter.get(
  '/alert-rules',
  h(async (req, res) => {
    res.json({ rules: filterAlertRulesByEnabled(req, alertRuleStore.list()) });
  }),
);

/**
 * GET /api/alert-rules/export — CSV of device-down rules on file.
 * Optional `?enabled=0|1` / `?deviceType=` match the list filters.
 * Operator-visible policy facts only (no secrets). Must stay ahead of
 * /alert-rules/:id so "export" is never parsed as an id.
 */
alertRulesRouter.get(
  '/alert-rules/export',
  h(async (req, res) => {
    const rules = filterAlertRulesByEnabled(req, alertRuleStore.list());
    sendCsv(
      res,
      'device-down-rules.csv',
      ['id', 'enabled', 'siteFilter', 'deviceTypeFilter', 'offlineMinutes', 'cooldownMinutes', 'createdAt'],
      rules.map((r) => [
        r.id,
        r.enabled ? 'true' : 'false',
        r.siteFilter ?? '',
        r.deviceTypeFilter ?? 'all',
        r.offlineMinutes,
        r.cooldownMinutes,
        r.createdAt ?? '',
      ]),
    );
  }),
);

alertRulesRouter.post(
  '/alert-rules',
  h(async (req, res) => {
    const parsed = parseRuleBody(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    const rule = alertRuleStore.create(parsed);
    logAlertRuleEvent(brokerDataDir(), 'alert-rule-created', rule, describeRule(rule, 'created'));
    res.status(201).json({ rule });
  }),
);

alertRulesRouter.put(
  '/alert-rules/:id',
  h(async (req, res) => {
    if (!alertRuleStore.get(req.params.id)) {
      res.status(404).json({ error: `unknown alert rule '${req.params.id}'` });
      return;
    }
    const parsed = parseRuleBody(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    const updated = alertRuleStore.update(req.params.id, parsed);
    if (!updated) {
      res.status(404).json({ error: `unknown alert rule '${req.params.id}'` });
      return;
    }
    logAlertRuleEvent(brokerDataDir(), 'alert-rule-updated', updated, describeRule(updated, 'updated'));
    res.json({ rule: updated });
  }),
);

alertRulesRouter.delete(
  '/alert-rules/:id',
  h(async (req, res) => {
    const removed = alertRuleStore.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: `unknown alert rule '${req.params.id}'` });
      return;
    }
    logAlertRuleEvent(brokerDataDir(), 'alert-rule-deleted', removed, describeRule(removed, 'deleted'));
    res.json({ ok: true, rule: removed });
  }),
);

/** The one-line summary the audit log records — what the rule does, never a
 *  body dump. */
function describeRule(rule: { enabled: boolean; siteFilter?: string; deviceTypeFilter?: string; offlineMinutes: number; cooldownMinutes: number }, verb: string): string {
  const scope = [
    rule.deviceTypeFilter ?? 'all types',
    rule.siteFilter ? `at ${rule.siteFilter}` : 'all sites',
  ].join(' ');
  return `${verb} — ${scope}, alert after ${rule.offlineMinutes}m offline, cooldown ${rule.cooldownMinutes}m, ${rule.enabled ? 'enabled' : 'disabled'}`;
}

/**
 * Parse a rule body into the store's input, or return the 400 message.
 * Field shapes are checked here; the value rules (ranges, the filter
 * vocabulary) are the shared validateDeviceDownRule — one definition for the
 * route and the tests.
 */
function parseRuleBody(raw: unknown): DeviceDownRuleInput | string {
  const body = (raw ?? {}) as Record<string, unknown>;
  const input: DeviceDownRuleInput = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
    input.enabled = body.enabled;
  }
  if (body.siteFilter !== undefined) {
    // Tri-state like the notification endpoints' hmacSecret: null clears.
    if (body.siteFilter === null) input.siteFilter = null;
    else if (typeof body.siteFilter !== 'string') return 'siteFilter must be a string or null';
    else input.siteFilter = body.siteFilter;
  }
  if (body.deviceTypeFilter !== undefined) {
    if (typeof body.deviceTypeFilter !== 'string') return 'deviceTypeFilter must be a string';
    const normalized = normalizeDeviceTypeFilter(body.deviceTypeFilter);
    if (!normalized) {
      return `deviceTypeFilter '${body.deviceTypeFilter}' is not one the engine knows — use all, switch, ap or gateway (aliases like 'switches', 'aps', 'gw' are fine)`;
    }
    input.deviceTypeFilter = normalized;
  }
  for (const field of ['offlineMinutes', 'cooldownMinutes'] as const) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'number') return `${field} must be a number`;
      input[field] = body[field] as number;
    }
  }

  const errors = validateDeviceDownRule(input);
  if (errors.length > 0) return errors.join('; ');
  return input;
}

// ---------------------------------------------------------------------------
// The notification center (the bell)
// ---------------------------------------------------------------------------

notificationCenterRouter.get(
  '/notifications/center',
  h(async (_req, res) => {
    res.json(notificationCenter.list());
  }),
);

/**
 * SSE snapshot stream for the in-app bell. Same payload as GET .../center,
 * pushed on an interval so the badge updates without a full page poll loop.
 * Falls back clients keep using the JSON endpoint.
 */
notificationCenterRouter.get('/notifications/center/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const write = () => {
    const body = notificationCenter.list();
    res.write(`event: center\ndata: ${JSON.stringify(body)}\n\n`);
  };
  write();
  const timer = setInterval(write, 15_000);
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
  });
});

notificationCenterRouter.post(
  '/notifications/center/mark-read',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.all === true) {
      res.json({ unread: notificationCenter.markAllRead() });
      return;
    }
    if (Array.isArray(body.ids) && body.ids.every((id) => typeof id === 'string')) {
      if (body.ids.length === 0) {
        res.status(400).json({ error: 'ids is empty — name the entries to mark read, or send {all: true}' });
        return;
      }
      res.json({ unread: notificationCenter.markRead(body.ids as string[]) });
      return;
    }
    res.status(400).json({ error: 'send {ids: string[]} for specific entries or {all: true} for everything' });
  }),
);
