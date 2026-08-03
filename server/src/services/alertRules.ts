/**
 * server/src/services/alertRules.ts — the device-down rules engine.
 *
 * Rules (shared/alertRules.ts) persist to data/alert-rules.json — the silence
 * store's own pattern: atomic write, 0600, HPE_DATA_DIR override for tests.
 * The file is an ENVELOPE: { rules, state }. `state` is the per-device
 * tracking snapshot (offlineSince / alertedFor / lastAlertedAt), so a restart
 * restores the engine exactly where it left off — no re-baseline, no lost
 * outage, no re-fired alert. Like silences, rules are real user data and
 * apply in BOTH demo and live mode: pointing a rule at the demo estate is how
 * the feature is tried out.
 *
 * The service runs on its OWN ~60s interval (HPE_ALERT_RULES_INTERVAL_MS
 * override), sampling the poller cache the way notifier.ts does — never
 * editing the poller. The disciplines are the repo's own: unref'd timer, one
 * evaluation at a time, an injected clock and sampler for tests.
 *
 * Every fire/recovery goes three places:
 *
 *   - the EXISTING notifier (notifier.dispatch) as a fired/resolved event, so
 *     the configured webhook/Slack/Teams/ntfy endpoints light up through the
 *     same render/sign/deliver path as queue transitions — demo mode included
 *     (the outbox, never the network);
 *   - the notification center (the bell);
 *   - the append-only change log, ticket '—' (a rule fire is not a brokered
 *     write — nothing leaves the portal).
 *
 * DEMO SHOWCASE. With demo mode on the service additionally evaluates the
 * VIRTUAL demo rule (DEMO_DEVICE_DOWN_RULE) against one scripted demo device
 * — the maintenance fixtures' pattern: computed in memory, never written to
 * the operator's store or state. The device is already offline when the
 * service starts with a seeded outage start two minutes old, so the FIRST
 * evaluation fires; it recovers seconds later and the SECOND evaluation sends
 * the all-clear. The whole lifecycle, no credentials, labelled demo.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_OFFLINE_MINUTES,
  DEMO_DEVICE_DOWN_DEVICE,
  DEMO_DEVICE_DOWN_RULE,
  DEVICES,
  deviceIsOffline,
  evaluateDeviceDownRules,
  type DeviceDownEvent,
  type DeviceDownRule,
  type DeviceDownRuleInput,
  type DeviceRow,
  type NotificationEvent,
  type ObservedDevice,
  type TrackedDeviceState,
} from '@hpe/shared';
import { effectiveSectionSource, settings } from '../config/settings';
import { poller } from './poller';
import { notificationCenter } from './notificationCenter';
import { notifier } from './notifier';
import { appendBrokerLog, brokerDataDir } from './writeBroker';

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** The on-disk envelope: rules AND the state machine's snapshot, one file. */
interface AlertRuleFile {
  rules: DeviceDownRule[];
  state: Record<string, TrackedDeviceState>;
}

export class AlertRuleStore {
  private doc: AlertRuleFile | null = null;

  constructor(private readonly dataDir: string = process.env.HPE_DATA_DIR ?? brokerDataDir()) {}

  private get file(): string {
    return path.join(this.dataDir, 'alert-rules.json');
  }

  /** The envelope exactly as persisted. An unreadable file reads as empty —
   *  the same tolerance the silence store shows — and the next save starts a
   *  fresh one. */
  private stored(): AlertRuleFile {
    if (this.doc !== null) {
      return { rules: this.doc.rules.map((r) => ({ ...r })), state: { ...this.doc.state } };
    }
    this.doc = { rules: [], state: {} };
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const doc = parsed as Partial<AlertRuleFile>;
        if (Array.isArray(doc.rules)) this.doc.rules = doc.rules as DeviceDownRule[];
        if (doc.state && typeof doc.state === 'object' && !Array.isArray(doc.state)) {
          this.doc.state = doc.state as Record<string, TrackedDeviceState>;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`alert rules: unreadable store, starting empty: ${(err as Error).message}`);
      }
    }
    return this.stored();
  }

  list(): DeviceDownRule[] {
    return this.stored().rules;
  }

  get(id: string): DeviceDownRule | null {
    return this.stored().rules.find((r) => r.id === id) ?? null;
  }

  /** Create and persist a rule. Validation lives in the route (it owns the
   *  400s); by the time this runs the input is well-formed. Absent minutes
   *  fields take their defaults here, once — the stored row is always
   *  explicit about what it does. */
  create(input: DeviceDownRuleInput, now: number = Date.now()): DeviceDownRule {
    const doc = this.stored();
    const rule: DeviceDownRule = {
      id: `arl-${new Date(now).getTime().toString(36)}${randomBytes(3).toString('hex')}`,
      enabled: input.enabled ?? true,
      ...(input.siteFilter?.trim() ? { siteFilter: input.siteFilter.trim() } : {}),
      ...(input.deviceTypeFilter && input.deviceTypeFilter !== 'all'
        ? { deviceTypeFilter: input.deviceTypeFilter }
        : {}),
      offlineMinutes: input.offlineMinutes ?? DEFAULT_OFFLINE_MINUTES,
      cooldownMinutes: input.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES,
      createdAt: new Date(now).toISOString(),
    };
    this.save({ rules: [rule, ...doc.rules], state: doc.state });
    return rule;
  }

  /** Apply a partial edit. Returns null for an unknown id — the route turns
   *  that into a 404. */
  update(id: string, input: DeviceDownRuleInput): DeviceDownRule | null {
    const doc = this.stored();
    const idx = doc.rules.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    const current = doc.rules[idx]!;
    const next: DeviceDownRule = {
      ...current,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.offlineMinutes !== undefined ? { offlineMinutes: input.offlineMinutes } : {}),
      ...(input.cooldownMinutes !== undefined ? { cooldownMinutes: input.cooldownMinutes } : {}),
    };
    if (input.siteFilter !== undefined) {
      // The keep/clear/replace tri-state: null (or a blank string, which the
      // route refuses before it gets here) clears the narrowing.
      if (typeof input.siteFilter === 'string' && input.siteFilter.trim()) next.siteFilter = input.siteFilter.trim();
      else delete next.siteFilter;
    }
    if (input.deviceTypeFilter !== undefined) {
      if (input.deviceTypeFilter === 'all') delete next.deviceTypeFilter;
      else next.deviceTypeFilter = input.deviceTypeFilter;
    }
    doc.rules[idx] = next;
    this.save(doc);
    return next;
  }

  /** Remove a rule by id. Returns the removed row, or null for an unknown
   *  id — and nothing is audit-logged for a removal that removed nothing. */
  remove(id: string): DeviceDownRule | null {
    const doc = this.stored();
    const idx = doc.rules.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    const [removed] = doc.rules.splice(idx, 1);
    this.save(doc);
    return removed ?? null;
  }

  /** The state machine's persisted snapshot — a copy; the service evaluates
   *  against it and hands the next one to saveState. */
  stateSnapshot(): Record<string, TrackedDeviceState> {
    return this.stored().state;
  }

  /** Persist the state machine's next snapshot, rules untouched. */
  saveState(state: ReadonlyMap<string, TrackedDeviceState>): void {
    const doc = this.stored();
    this.save({ rules: doc.rules, state: Object.fromEntries(state) });
  }

  private save(doc: AlertRuleFile): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.doc = doc;
  }
}

export const alertRuleStore = new AlertRuleStore();

// ---------------------------------------------------------------------------
// Sampling — the same source decision /api/devices makes
// ---------------------------------------------------------------------------

/** One DeviceRow as the engine's observation. The tracking identity is the
 *  serial when the plane reports one, else the name (the authored fixtures
 *  carry no serials). */
function toObservation(row: DeviceRow): ObservedDevice {
  return {
    serial: row.serial ?? row.name,
    name: row.name,
    type: row.type,
    state: row.state,
    siteId: row.siteId,
    siteName: row.siteName,
    plane: row.plane,
  };
}

/**
 * Collapse duplicate sightings of one identity (a device several planes
 * claim) to a single observation. A device is DOWN only when EVERY plane
 * that knows it says so — one plane still hearing from it means the device
 * is alive, and a down-page on partial evidence is the false alarm that
 * kills trust in the whole feature.
 */
function dedupeObservations(rows: readonly ObservedDevice[]): ObservedDevice[] {
  const byIdentity = new Map<string, ObservedDevice[]>();
  for (const row of rows) {
    const group = byIdentity.get(row.serial);
    if (group) group.push(row);
    else byIdentity.set(row.serial, [row]);
  }
  const out: ObservedDevice[] = [];
  for (const group of byIdentity.values()) {
    // Up-wins: any sighting of the device alive stands for the group; only a
    // unanimous down is down.
    out.push(group.find((row) => !deviceIsOffline(row.state)) ?? group[0]!);
  }
  return out;
}

/** How the /api/devices route picks its rows: the section's effective source,
 *  with the blend swap when demo+blendLive and a plane has reported. The
 *  engine must watch the SAME estate the operator is looking at. */
function defaultSampleDevices(): ObservedDevice[] {
  const s = settings.get();
  const live: ObservedDevice[] = [];
  for (const [, pull] of poller.contributionsByPlane()) {
    if (pull.devices) for (const row of pull.devices) live.push(toObservation(row));
  }
  if (effectiveSectionSource(s, 'devices') === 'demo') {
    const blend = s.blendLive === true && s.sectionMode?.devices !== 'demo';
    const source = blend && live.length > 0 ? live : DEVICES.map(toObservation);
    return dedupeObservations(source);
  }
  return dedupeObservations(live);
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface AlertRulesServiceOptions {
  store?: AlertRuleStore; // default: the process-wide singleton
  sampleDevices?: () => ObservedDevice[]; // default: the same source decision as /api/devices
  demoMode?: () => boolean; // default: the settings store
  /** Where fires/recoveries go. Default: bell + notifier + audit log. */
  dispatch?: (event: DeviceDownEvent) => Promise<void> | void;
  intervalMs?: number; // default 60s, HPE_ALERT_RULES_INTERVAL_MS override
  nowMs?: () => number; // injected clock for tests
  /** How long the scripted demo device stays down after start (default 30s,
   *  so the second 60s-tick evaluation sends its recovery). */
  demoOfflineMs?: number;
}

function defaultIntervalMs(): number {
  const raw = Number(process.env.HPE_ALERT_RULES_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 60_000;
}

export class AlertRulesService {
  private readonly store: AlertRuleStore;
  private readonly sampleDevices: () => ObservedDevice[];
  private readonly demoMode: () => boolean;
  private readonly dispatchEvent: (event: DeviceDownEvent) => Promise<void> | void;
  private readonly intervalMs: number;
  private readonly nowMs: () => number;
  private readonly demoOfflineMs: number;

  private timer: NodeJS.Timeout | null = null;
  private evaluating = false;
  private startedAtMs: number | null = null;
  /** The scripted demo device's tracking state — memory only, NEVER persisted
   *  (the showcase must not put rows in the operator's data). */
  private demoState: Map<string, TrackedDeviceState> | null = null;
  private lastEvaluatedAt: string | null = null;

  constructor(opts: AlertRulesServiceOptions = {}) {
    this.store = opts.store ?? alertRuleStore;
    this.sampleDevices = opts.sampleDevices ?? defaultSampleDevices;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.dispatchEvent = opts.dispatch ?? defaultDispatch;
    this.intervalMs = opts.intervalMs ?? defaultIntervalMs();
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.demoOfflineMs = opts.demoOfflineMs ?? 30_000;
  }

  /** One immediate evaluation plus one per interval — the timer never keeps
   *  the process alive (the poller's own rule). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.evaluateNow();
    }, this.intervalMs);
    this.timer.unref();
    void this.evaluateNow();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Evaluate the current sample against the rules and dispatch every event.
   * One at a time: a slow dispatch must never let two evaluations overlap.
   * The state snapshot persists ONLY when something moved — a quiet minute
   * writes nothing.
   */
  async evaluateNow(): Promise<DeviceDownEvent[]> {
    if (this.evaluating) return [];
    this.evaluating = true;
    try {
      const now = this.nowMs();
      this.startedAtMs ??= now;
      const previous = new Map(Object.entries(this.store.stateSnapshot()));
      const result = evaluateDeviceDownRules(this.store.list(), this.sampleDevices(), previous, now);
      if (result.changed) this.store.saveState(result.state);
      const events: DeviceDownEvent[] = [...result.events];

      if (this.demoMode()) {
        // The scripted demo device: already offline at service start with the
        // outage seeded two minutes old (fires on the FIRST evaluation
        // against the 1-minute demo rule), up again after demoOfflineMs (the
        // SECOND evaluation sends the recovery). State is memory-only.
        if (!this.demoState) this.demoState = seedDemoState(this.startedAtMs);
        const demoDevice: ObservedDevice = {
          ...DEMO_DEVICE_DOWN_DEVICE,
          state: now - this.startedAtMs < this.demoOfflineMs ? 'down' : 'up',
        };
        const demoResult = evaluateDeviceDownRules([DEMO_DEVICE_DOWN_RULE], [demoDevice], this.demoState, now);
        this.demoState = demoResult.state;
        for (const event of demoResult.events) events.push({ ...event, demo: true });
      }

      for (const event of events) await this.dispatchEvent(event);
      this.lastEvaluatedAt = new Date(now).toISOString();
      return events;
    } finally {
      this.evaluating = false;
    }
  }
}

/** The demo device's seeded first state: mid-outage when the service starts,
 *  so the showcase fires immediately rather than after a wait. */
function seedDemoState(startedAtMs: number): Map<string, TrackedDeviceState> {
  return new Map([
    [
      DEMO_DEVICE_DOWN_DEVICE.serial,
      {
        serial: DEMO_DEVICE_DOWN_DEVICE.serial,
        name: DEMO_DEVICE_DOWN_DEVICE.name,
        status: 'down' as const,
        offlineSince: new Date(startedAtMs - 2 * 60_000).toISOString(),
        alertedFor: null,
        lastAlertedAt: null,
      },
    ],
  ]);
}

export const alertRulesService = new AlertRulesService();

// ---------------------------------------------------------------------------
// Dispatch — bell, notifier, audit
// ---------------------------------------------------------------------------

/** The engine event as the notifier's fired/resolved vocabulary, so the
 *  existing endpoints light up with no new render path. */
export function toNotificationEvent(event: DeviceDownEvent, now: number = Date.now()): NotificationEvent {
  const fired = event.kind === 'fired';
  return {
    id: `evt-${now.toString(36)}${randomBytes(3).toString('hex')}`,
    kind: fired ? 'fired' : 'resolved',
    at: event.at,
    fingerprint: event.dedupKey,
    plane: event.device.plane ?? '—',
    device: event.device.name,
    title: fired ? 'Device offline' : 'Device back online',
    sev: 'P2',
    state: fired ? 'open' : 'closed',
    siteName: event.device.siteName ?? '—',
    age: `${event.offlineMinutes}m`,
    count: 1,
    detail: fired
      ? `${event.device.name} has been offline for ${event.offlineMinutes}m — rule ${event.rule.id} alerts after ${event.rule.offlineMinutes}m.`
      : `${event.device.name} is back online after ${event.offlineMinutes}m offline.`,
  };
}

/** One fire/recovery to all three destinations. Never throws into the
 *  evaluation loop — the bell store already degrades on its own failures,
 *  and the notifier swallows per-endpoint failures by design. */
async function defaultDispatch(event: DeviceDownEvent): Promise<void> {
  const fired = event.kind === 'fired';
  notificationCenter.push({
    title: fired ? `${event.device.name} offline` : `${event.device.name} back online`,
    body: fired
      ? `${event.device.name} (${event.device.type}) at ${event.device.siteName ?? 'unknown site'} has been offline for ${event.offlineMinutes}m — rule ${event.rule.id} alerts after ${event.rule.offlineMinutes}m.`
      : `${event.device.name} is back online after ${event.offlineMinutes}m offline.`,
    severity: fired ? 'danger' : 'success',
    deviceSerial: event.device.serial,
    // The scripted demo device is not in the inventory, so its entries do not
    // link anywhere — a bell click that 404s would make the showcase look
    // broken. Real devices always link to their detail page.
    url: event.demo ? undefined : `/devices/${encodeURIComponent(event.device.name)}`,
    ...(event.demo ? { demo: true } : {}),
  });
  await notifier.dispatch(toNotificationEvent(event));
  appendBrokerLog(brokerDataDir(), {
    ts: event.at,
    event: fired ? 'device-down-alert' : 'device-down-recovered',
    changeId: event.dedupKey,
    // A rule fire is not a brokered write — nothing is pushed to a plane — so
    // no ticket authorises it, exactly like a silence.
    ticket: '—',
    kind: 'alert',
    result:
      (fired
        ? `offline ${event.offlineMinutes}m — rule ${event.rule.id} (alert after ${event.rule.offlineMinutes}m)`
        : `recovered after ${event.offlineMinutes}m offline — rule ${event.rule.id}`) +
      (event.demo ? ' — demo showcase' : ''),
    device: event.device.name,
    serial: event.device.serial,
    ...(event.device.plane ? { plane: event.device.plane } : {}),
  });
}

/** One audit-log line for a rule create/update/delete. Never a payload body. */
export function logAlertRuleEvent(
  dataDir: string,
  event: 'alert-rule-created' | 'alert-rule-updated' | 'alert-rule-deleted',
  rule: DeviceDownRule,
  result: string,
  now: number = Date.now(),
): void {
  appendBrokerLog(dataDir, {
    ts: new Date(now).toISOString(),
    event,
    changeId: rule.id,
    ticket: '—',
    kind: 'alert',
    result,
  });
}
