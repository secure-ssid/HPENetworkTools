/**
 * server/src/routes/alertRules.ts — device-down rule CRUD + the notification
 * center (the bell).
 *
 *   GET    /api/alert-rules                        every rule on file
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
} from '@hpe/shared';
import { h } from './handler';
import { alertRuleStore, logAlertRuleEvent } from '../services/alertRules';
import { notificationCenter } from '../services/notificationCenter';
import { brokerDataDir } from '../services/writeBroker';

export const alertRulesRouter = Router();
export const notificationCenterRouter = Router();

alertRulesRouter.get(
  '/alert-rules',
  h(async (_req, res) => {
    res.json({ rules: alertRuleStore.list() });
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
