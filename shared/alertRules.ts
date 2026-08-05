/**
 * shared/alertRules.ts — device-down alert rules + the in-app notification center.
 *
 * The alert queue (alertEngine.ts) watches what planes REPORT as alerts. A
 * device that simply stops reporting is a different failure: no plane raises
 * an alert for it, so nothing fires. This module is the contract half of the
 * device-down rules engine — the rule shape, the per-device state machine,
 * and the bell entries the engine writes. No I/O and no clock beyond the
 * `now` a caller hands in, so the server service, the routes and the browser
 * all share exactly one definition of "offline", "alerted" and "cooled down".
 *
 * The state machine, per tracked device:
 *
 *   - BASELINE. The first time the engine ever sees a device it records what
 *     it saw and alerts about NOTHING. A device first seen offline is
 *     baseline-offline (offlineSince stays null): that outage has no known
 *     start, so no threshold can ever be met for it and it NEVER alerts —
 *     the boot-storm rule. Devices discovered later baseline the same way.
 *   - OUTAGE. An up→down transition stamps offlineSince. While down, the
 *     most aggressive matching rule (lowest offlineMinutes, ties broken by
 *     lowest id) sets the threshold: at offlineMinutes the outage may alert.
 *   - TWO GATES, both independent. An outage alerts only when (1) it has not
 *     already alerted — alertedFor !== offlineSince — and (2) the previous
 *     alert's cooldown window has passed — now ≥ lastAlertedAt +
 *     cooldownMinutes. Gate 1 stops repeats of THIS outage; gate 2 stops a
 *     flapping device paging on every bounce.
 *   - RECOVERY. A down→up transition notifies ONLY when the outage that just
 *     ended was actually alerted (alertedFor === offlineSince): a quiet
 *     outage gets a quiet end, the queue's own inhibition rule.
 *
 * Dedup keys name the EVENT — `${serial}@${outageStart}` — so a NEW outage of
 * the same device is a new event and fires again, while a restart that
 * restores the persisted snapshot sees the SAME key and stays quiet.
 *
 * "Serial" throughout is the tracking identity: the plane's serial number
 * when it reports one, else the device name (the authored fixtures carry no
 * serials — see Device.serial in types.ts).
 */

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** The type vocabulary a rule can narrow to. 'all' matches every type. */
export type DeviceTypeFilter = 'all' | 'switch' | 'ap' | 'gateway';

export const DEVICE_TYPE_FILTERS: readonly DeviceTypeFilter[] = ['all', 'switch', 'ap', 'gateway'];

/**
 * Alias table for the filter vocabulary, so 'Switches', 'APs' and 'gw' all
 * mean their canonical word. Matching is case-insensitive with runs of
 * whitespace/underscores collapsed to single dashes.
 */
const DEVICE_TYPE_ALIASES: Record<string, DeviceTypeFilter> = {
  all: 'all',
  '*': 'all',
  any: 'all',
  switch: 'switch',
  switches: 'switch',
  sw: 'switch',
  ap: 'ap',
  aps: 'ap',
  'access-point': 'ap',
  'access-points': 'ap',
  accesspoint: 'ap',
  gateway: 'gateway',
  gateways: 'gateway',
  gw: 'gateway',
};

/**
 * Normalize a raw filter string to the canonical vocabulary, or null when it
 * names nothing the engine knows. The route turns null into a 400 that lists
 * the accepted words — refused, never repaired into 'all'.
 */
export function normalizeDeviceTypeFilter(raw: string): DeviceTypeFilter | null {
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return DEVICE_TYPE_ALIASES[key] ?? null;
}

/** Bounds every minutes field obeys: 1 minute to a full day. */
export const MIN_RULE_MINUTES = 1;
export const MAX_RULE_MINUTES = 1440;
export const DEFAULT_OFFLINE_MINUTES = 5;
export const DEFAULT_COOLDOWN_MINUTES = 60;

/** A device-down rule, as persisted in data/alert-rules.json. */
export interface DeviceDownRule {
  id: string;
  enabled: boolean;
  /** Site id OR display name, matched case-insensitively. Absent = every site. */
  siteFilter?: string;
  /** Canonical on write (the route normalizes). Absent = 'all'. */
  deviceTypeFilter?: DeviceTypeFilter;
  /** How long a device must be continuously offline before alerting. */
  offlineMinutes: number;
  /** How long after one alert a DIFFERENT outage of the same device stays quiet. */
  cooldownMinutes: number;
  createdAt: string; // ISO
}

/** What a create/update accepts; the store stamps id/createdAt. `siteFilter`
 *  on update follows the keep/clear/replace tri-state (the notification
 *  endpoints' own hmacSecret convention): absent keeps, null clears, a
 *  non-empty string replaces. */
export interface DeviceDownRuleInput {
  enabled?: boolean;
  siteFilter?: string | null;
  deviceTypeFilter?: DeviceTypeFilter;
  offlineMinutes?: number;
  cooldownMinutes?: number;
}

/** Field-level errors, refusing rather than repairing (the repo's rule).
 *  Empty = valid. Absent minutes fields take their defaults. */
export function validateDeviceDownRule(input: DeviceDownRuleInput): string[] {
  const errors: string[] = [];
  for (const [field, value] of [
    ['offlineMinutes', input.offlineMinutes],
    ['cooldownMinutes', input.cooldownMinutes],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < MIN_RULE_MINUTES || value > MAX_RULE_MINUTES) {
      errors.push(`${field} must be a whole number of minutes between ${MIN_RULE_MINUTES} and ${MAX_RULE_MINUTES} (24h)`);
    }
  }
  if (input.siteFilter !== undefined && input.siteFilter !== null && !input.siteFilter.trim()) {
    errors.push('siteFilter must name a site when provided — send null to clear it, or omit it to match every site');
  }
  if (input.deviceTypeFilter !== undefined && !DEVICE_TYPE_FILTERS.includes(input.deviceTypeFilter)) {
    errors.push(`deviceTypeFilter must be one of ${DEVICE_TYPE_FILTERS.join(', ')}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Observations + the offline vocabulary
// ---------------------------------------------------------------------------

/** One device as one evaluation sample sees it. */
export interface ObservedDevice {
  /** The tracking identity: serial when the plane reports one, else the name. */
  serial: string;
  name: string;
  type: string; // DeviceType, but compared through the alias table
  /** The plane's own state word, verbatim — deviceIsOffline reads it. */
  state: string;
  siteId?: string;
  siteName?: string;
  plane?: string;
}

/**
 * The state words that mean "the device itself is down". Deliberately tight:
 * reconciliation vocabulary ('missing', 'stale', 'double-claimed') describes
 * the RECORD, not the device, and 'degraded'/'flapping' mean the plane still
 * hears from it. Live adapters say 'down'/'offline'; the fixtures add
 * 'no heartbeat'.
 */
const OFFLINE_STATES: ReadonlySet<string> = new Set([
  'offline',
  'down',
  'no heartbeat',
  'disconnected',
  'unreachable',
]);

export function deviceIsOffline(state: string): boolean {
  return OFFLINE_STATES.has(state.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// The per-device state machine
// ---------------------------------------------------------------------------

/** The part of a rule an event needs — snapshotted into the device state at
 *  fire time, so a rule DELETED mid-outage cannot strand the recovery notice:
 *  an operator who was paged gets the all-clear even when the rule is gone. */
export type DeviceDownRuleRef = Pick<DeviceDownRule, 'id' | 'offlineMinutes' | 'cooldownMinutes'>;

/** What the engine remembers about one device, persisted in the rule store's
 *  own JSON file so a restart picks the tracking up exactly where it left off. */
export interface TrackedDeviceState {
  serial: string; // the tracking identity (map key)
  name: string; // last-observed display name, for the snapshot's readability
  status: 'up' | 'down';
  /** ISO the current outage started. Null while up, AND null for a device
   *  baselined offline — that outage's start is unknown, so it can never
   *  meet a threshold and never alerts (the boot-storm rule). */
  offlineSince: string | null;
  /** The outage start this device already alerted for (gate 1). */
  alertedFor: string | null;
  /** When the last alert fired (gate 2's cooldown runs from here). */
  lastAlertedAt: string | null;
  /** The rule that fired the current/last alert, snapshotted at fire time. */
  alertedRule?: DeviceDownRuleRef | null;
}

/** One engine decision: an outage crossed its rule's threshold, or an alerted
 *  outage ended. */
export interface DeviceDownEvent {
  kind: 'fired' | 'recovered';
  /** The event's identity: `${serial}@${outageStart}` — a new outage of the
   *  same device is a new key and fires again. */
  dedupKey: string;
  /** The rule that fired: the live rule for a fire, the fire-time snapshot
   *  for a recovery (which must arrive even if the rule was since deleted). */
  rule: DeviceDownRuleRef;
  device: ObservedDevice;
  outageStart: string; // ISO
  /** Whole minutes offline at the decision: the threshold crossing for a
   *  fire, the outage's full length for a recovery. */
  offlineMinutes: number;
  at: string; // ISO of the evaluation
  /** True on the demo showcase's events — labelled, never mistaken for the
   *  operator's estate. */
  demo?: boolean;
}

export interface RuleEvaluationResult {
  events: DeviceDownEvent[];
  /** The next per-device state — a NEW map; persist it only when `changed`. */
  state: Map<string, TrackedDeviceState>;
  /** False when nothing moved, so the caller skips the persist write. */
  changed: boolean;
  /** Identities dropped by the cap this pass — all of them absent from the
   *  sample, none of them a device the engine can still see. */
  evicted: number;
  /** Live devices held ABOVE MAX_TRACKED_DEVICES because evicting them would
   *  have blinded the engine to an estate it can see. Non-zero means the cap
   *  is being deliberately exceeded, which the caller should say out loud. */
  trackedBeyondCap: number;
}

/** Does a rule speak for this device? Disabled rules speak for nothing. */
export function ruleMatchesDevice(rule: DeviceDownRule, device: ObservedDevice): boolean {
  if (!rule.enabled) return false;
  const typeFilter = rule.deviceTypeFilter ?? 'all';
  if (typeFilter !== 'all' && normalizeDeviceTypeFilter(device.type) !== typeFilter) return false;
  const site = rule.siteFilter?.trim().toLowerCase();
  if (site) {
    const byId = (device.siteId ?? '').trim().toLowerCase() === site;
    const byName = (device.siteName ?? '').trim().toLowerCase() === site;
    if (!byId && !byName) return false;
  }
  return true;
}

/**
 * The rule a device answers to: the most aggressive matching one — lowest
 * offlineMinutes, ties broken by lowest id so the choice is stable and never
 * depends on store ordering. Null = no rule speaks for this device.
 */
export function selectRuleForDevice(
  rules: readonly DeviceDownRule[],
  device: ObservedDevice,
): DeviceDownRule | null {
  let best: DeviceDownRule | null = null;
  for (const rule of rules) {
    if (!ruleMatchesDevice(rule, device)) continue;
    if (
      best === null ||
      rule.offlineMinutes < best.offlineMinutes ||
      (rule.offlineMinutes === best.offlineMinutes && rule.id < best.id)
    ) {
      best = rule;
    }
  }
  return best;
}

/**
 * The tracked-estate cap. Churned identities (renamed APs, replaced kit)
 * would otherwise accumulate forever; eviction is oldest-discovered first.
 *
 * It bounds identities the sample NO LONGER CONTAINS. A device still being
 * observed is never evicted, however old its entry, because "a rediscovered
 * device simply baselines again" is only harmless for a device that actually
 * went away. For a device still in front of the engine, re-baselining is not
 * a fresh start but an erasure: it takes the outage clock back to null, and a
 * device whose outage start is unknowable can never alert.
 */
export const MAX_TRACKED_DEVICES = 500;

/**
 * Evaluate one sample of the estate against the rules. Pure: no I/O, the
 * clock is the caller's, the previous state comes in and the next goes out.
 *
 * Every observed device is tracked — even one no rule matches — so a rule
 * created LATER meets an accurate history (a known outage start) rather than
 * a fresh baseline. Only rule-matched devices can produce events.
 */
export function evaluateDeviceDownRules(
  rules: readonly DeviceDownRule[],
  devices: readonly ObservedDevice[],
  previous: ReadonlyMap<string, TrackedDeviceState>,
  now: number,
): RuleEvaluationResult {
  const state = new Map<string, TrackedDeviceState>();
  for (const [key, value] of previous) state.set(key, { ...value });
  const events: DeviceDownEvent[] = [];
  let changed = false;
  const nowIso = new Date(now).toISOString();

  for (const device of devices) {
    const offline = deviceIsOffline(device.state);
    const prev = state.get(device.serial);
    const rule = selectRuleForDevice(rules, device);

    if (!prev) {
      // First sight EVER: baseline. Offline at first sight means the outage
      // start is unknowable — offlineSince stays null and this outage can
      // never alert (see the header).
      state.set(device.serial, {
        serial: device.serial,
        name: device.name,
        status: offline ? 'down' : 'up',
        offlineSince: null,
        alertedFor: null,
        lastAlertedAt: null,
      });
      changed = true;
      continue;
    }

    if (prev.name !== device.name) {
      prev.name = device.name;
      changed = true;
    }

    if (prev.status !== 'down' && offline) {
      // up → down: the outage starts at the evaluation that first saw it —
      // the sample is all the engine knows, so the observation time is the
      // honest start.
      prev.status = 'down';
      prev.offlineSince = nowIso;
      changed = true;
    } else if (prev.status === 'down' && !offline) {
      // down → up. Recovery is announced ONLY for an outage that actually
      // alerted — a quiet outage gets a quiet end. The rule named on the
      // notice is the fire-time snapshot, so deleting the rule mid-outage
      // cannot strand the all-clear.
      if (prev.alertedFor !== null && prev.alertedFor === prev.offlineSince) {
        const ruleRef: DeviceDownRuleRef = prev.alertedRule ??
          rule ?? { id: 'deleted-rule', offlineMinutes: 0, cooldownMinutes: 0 };
        const started = Date.parse(prev.offlineSince ?? '');
        events.push({
          kind: 'recovered',
          dedupKey: `${device.serial}@${prev.offlineSince}`,
          rule: ruleRef,
          device,
          outageStart: prev.offlineSince ?? nowIso,
          offlineMinutes: Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60_000)) : 0,
          at: nowIso,
        });
      }
      prev.status = 'up';
      prev.offlineSince = null;
      changed = true;
    }

    if (prev.status === 'down' && prev.offlineSince !== null && rule) {
      const started = Date.parse(prev.offlineSince);
      if (Number.isFinite(started)) {
        const downMs = now - started;
        const thresholdMs = rule.offlineMinutes * 60_000;
        // Gate 1: this outage already alerted. Gate 2: the previous alert's
        // cooldown is still running.
        const alreadyAlerted = prev.alertedFor === prev.offlineSince;
        const lastAlerted = prev.lastAlertedAt ? Date.parse(prev.lastAlertedAt) : NaN;
        const coolingDown =
          Number.isFinite(lastAlerted) && now < lastAlerted + rule.cooldownMinutes * 60_000;
        if (downMs >= thresholdMs && !alreadyAlerted && !coolingDown) {
          events.push({
            kind: 'fired',
            dedupKey: `${device.serial}@${prev.offlineSince}`,
            rule,
            device,
            outageStart: prev.offlineSince,
            offlineMinutes: Math.floor(downMs / 60_000),
            at: nowIso,
          });
          prev.alertedFor = prev.offlineSince;
          prev.lastAlertedAt = nowIso;
          prev.alertedRule = {
            id: rule.id,
            offlineMinutes: rule.offlineMinutes,
            cooldownMinutes: rule.cooldownMinutes,
          };
          changed = true;
        }
      }
    }
  }

  // Eviction happens ONCE, after the sample is fully known, and only ever
  // takes identities the sample no longer contains. Doing it inside the
  // first-sight branch meant an estate one device larger than the cap evicted
  // a device it had just seen, which made that device unknown on the next
  // pass, which baselined it, which evicted the next one: every device in the
  // estate re-baselined every evaluation, no outage clock ever survived, and
  // the engine went permanently silent for exactly the large estates that
  // need it most. Silence is what a healthy estate looks like, so nothing
  // about the failure was visible.
  let evicted = 0;
  let trackedBeyondCap = 0;
  if (state.size > MAX_TRACKED_DEVICES) {
    const observed = new Set(devices.map((device) => device.serial));
    for (const key of [...state.keys()]) {
      if (state.size <= MAX_TRACKED_DEVICES) break;
      if (observed.has(key)) continue;
      state.delete(key);
      evicted += 1;
      changed = true;
    }
    // Whatever is left over the cap is live estate. Holding it is the lesser
    // harm — the alternative is an engine that cannot see devices that are
    // right there — but it is a bound being knowingly exceeded, not a bound
    // that held.
    trackedBeyondCap = Math.max(0, state.size - MAX_TRACKED_DEVICES);
  }

  return { events, state, changed, evicted, trackedBeyondCap };
}

// ---------------------------------------------------------------------------
// The demo showcase
// ---------------------------------------------------------------------------

/**
 * The demo rule and its device — VIRTUAL, exactly like the maintenance
 * fixtures' silences: the service evaluates them in memory while demo mode
 * is on and never writes them to the operator's store. The device is
 * scripted (services/alertRules.ts): already offline when the service
 * starts with a seeded outage start two minutes in the past, so the FIRST
 * evaluation fires against this 1-minute rule; it recovers seconds later,
 * so the second evaluation sends the recovery. Fire and all-clear, the full
 * lifecycle, with no credentials and no network.
 */
export const DEMO_DEVICE_DOWN_RULE: DeviceDownRule = {
  id: 'demo-device-down',
  enabled: true,
  deviceTypeFilter: 'all',
  offlineMinutes: 1,
  cooldownMinutes: 60,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** The scripted demo device's stable identity. */
export const DEMO_DEVICE_DOWN_DEVICE = {
  serial: 'DEMO-AP-WATCH1',
  name: 'demo-ap-watch1',
  type: 'ap',
  siteId: 'campus-01',
  siteName: 'Campus-01 HQ',
  plane: 'MIST',
} as const;

// ---------------------------------------------------------------------------
// The notification center (the bell)
// ---------------------------------------------------------------------------

/** Severity vocabulary for bell entries — the UI maps it straight to tones. */
export type NotificationCenterSeverity = 'danger' | 'warning' | 'info' | 'success';

/** One entry in the in-app notification center. */
export interface NotificationCenterEntry {
  id: string;
  title: string;
  body: string;
  severity: NotificationCenterSeverity;
  /** The tracking identity of the device the entry is about, when there is one. */
  deviceSerial?: string;
  /** Where clicking takes the operator; absent = nowhere to go. */
  url?: string;
  createdAt: string; // ISO
  read: boolean;
  /** True on the demo showcase's entries — labelled, like the demo outbox. */
  demo?: boolean;
}

/** GET /api/notifications/center — the newest page plus the global unread
 *  count. Single-operator: one read flag per entry, no per-user state. */
export interface NotificationCenterView {
  entries: NotificationCenterEntry[];
  unread: number;
}

/** How many entries the center endpoint serves — the dropdown's depth. */
export const NOTIFICATION_CENTER_PAGE = 15;

/** The store's ceiling — a feed, not an archive. The change log is the
 *  archive; the center keeps the recent, actionable tail. */
export const NOTIFICATION_CENTER_CAPACITY = 200;
