/**
 * server/tests/alertRules.test.ts — the device-down rules engine.
 *
 * HPE_SETTINGS_PATH / HPE_DATA_DIR point at a tmp dir so the test never
 * touches real data/. The env vars must be set before the app modules are
 * imported (the store singletons resolve their dir at construction), so
 * everything from src/ is loaded with dynamic imports inside beforeAll — the
 * same harness silences.test.ts uses.
 *
 * Covered:
 *   state machine — baseline-seed (already-offline devices NEVER alert for
 *     that outage; late-discovered devices baseline the same way), threshold
 *     crossing, gate 1 (no repeat for the same outage), gate 2 (the cooldown
 *     window from the previous alert), recovery ONLY for alerted outages
 *     (and still delivered when the rule was deleted mid-outage), rule
 *     selection (most aggressive, id tie-break, filters), the offline
 *     vocabulary and type-filter alias normalization;
 *   store — defaults, persistence across instances, 0600, partial update,
 *     remove, corrupt file reads empty, the state snapshot round-trip;
 *   service — evaluateNow baselines before it fires, a fire dispatches and
 *     persists, a restart (new service, same store) does not refire, the
 *     demo showcase fires then recovers and never touches the persisted
 *     state, and duplicate sightings of one device are up-wins;
 *   routes — validation 400s (refusing, never repairing), CRUD + audit
 *     lines, 404s;
 *   dispatch — the demo showcase through the REAL singleton path lands in
 *     the notifier outbox (the fired transition riding the existing render
 *     path), the bell (demo-labelled, unread) and the audit log, and gate 1
 *     holds across real repeated evaluations.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_DEVICE_DOWN_DEVICE,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_OFFLINE_MINUTES,
  deviceIsOffline,
  evaluateDeviceDownRules,
  normalizeDeviceTypeFilter,
  selectRuleForDevice,
  validateDeviceDownRule,
  type DeviceDownEvent,
  type DeviceDownRule,
  type ObservedDevice,
  type TrackedDeviceState,
} from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let AlertRuleStore: typeof import('../src/services/alertRules').AlertRuleStore;
let alertRuleStore: typeof import('../src/services/alertRules').alertRuleStore;
let AlertRulesService: typeof import('../src/services/alertRules').AlertRulesService;
let alertRulesService: typeof import('../src/services/alertRules').alertRulesService;
let notifier: typeof import('../src/services/notifier').notifier;
let notificationStore: typeof import('../src/services/notifierStore').notificationStore;
let notificationCenter: typeof import('../src/services/notificationCenter').notificationCenter;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-alert-rules-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const mod = await import('../src/services/alertRules');
  AlertRuleStore = mod.AlertRuleStore;
  alertRuleStore = mod.alertRuleStore;
  AlertRulesService = mod.AlertRulesService;
  alertRulesService = mod.alertRulesService;
  notifier = (await import('../src/services/notifier')).notifier;
  notificationStore = (await import('../src/services/notifierStore')).notificationStore;
  notificationCenter = (await import('../src/services/notificationCenter')).notificationCenter;
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

afterEach(() => {
  // The route tests share the singleton store; leave it empty for the next one.
  for (const r of alertRuleStore.list()) alertRuleStore.remove(r.id);
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function sendJson(method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function auditEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(join(tmpDir, 'data', 'change-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const MIN = 60_000;

function dev(over: Partial<ObservedDevice> = {}): ObservedDevice {
  return {
    serial: 'SER-1',
    name: 'ap-1f-04',
    type: 'ap',
    state: 'up',
    siteId: 'campus-01',
    siteName: 'Campus-01 HQ',
    plane: 'CENTRAL',
    ...over,
  };
}

function rule(over: Partial<DeviceDownRule> = {}): DeviceDownRule {
  return {
    id: 'arl-test',
    enabled: true,
    offlineMinutes: 5,
    cooldownMinutes: 60,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function emptyState(): Map<string, TrackedDeviceState> {
  return new Map();
}

// ---------------------------------------------------------------------------
// The offline vocabulary + filter normalization + validation
// ---------------------------------------------------------------------------

describe('deviceIsOffline', () => {
  it('reads the down vocabulary case-insensitively', () => {
    for (const word of ['offline', 'down', 'no heartbeat', 'disconnected', 'unreachable', '  DOWN ']) {
      expect(deviceIsOffline(word)).toBe(true);
    }
  });

  it('does not read record-state or alive words as down', () => {
    for (const word of ['up', 'degraded', 'flapping', 'missing', 'stale', 'double-claimed', '']) {
      expect(deviceIsOffline(word)).toBe(false);
    }
  });
});

describe('normalizeDeviceTypeFilter', () => {
  it('maps aliases into the canonical vocabulary', () => {
    expect(normalizeDeviceTypeFilter('Switches')).toBe('switch');
    expect(normalizeDeviceTypeFilter('sw')).toBe('switch');
    expect(normalizeDeviceTypeFilter('APs')).toBe('ap');
    expect(normalizeDeviceTypeFilter('access point')).toBe('ap');
    expect(normalizeDeviceTypeFilter('gw')).toBe('gateway');
    expect(normalizeDeviceTypeFilter('*')).toBe('all');
  });

  it('rejects words outside the vocabulary', () => {
    expect(normalizeDeviceTypeFilter('nonsense')).toBeNull();
    expect(normalizeDeviceTypeFilter('')).toBeNull();
  });
});

describe('validateDeviceDownRule', () => {
  it('accepts a valid rule and absent minutes fields', () => {
    expect(validateDeviceDownRule({})).toEqual([]);
    expect(validateDeviceDownRule({ offlineMinutes: 1, cooldownMinutes: 1440 })).toEqual([]);
  });

  it('refuses out-of-range and fractional minutes', () => {
    expect(validateDeviceDownRule({ offlineMinutes: 0 })).not.toEqual([]);
    expect(validateDeviceDownRule({ offlineMinutes: 1441 })).not.toEqual([]);
    expect(validateDeviceDownRule({ cooldownMinutes: 1.5 })).not.toEqual([]);
  });

  it('refuses an empty site filter and an unknown type filter', () => {
    expect(validateDeviceDownRule({ siteFilter: '   ' })).not.toEqual([]);
    expect(validateDeviceDownRule({ deviceTypeFilter: 'controller' as never })).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe('evaluateDeviceDownRules — baseline', () => {
  it('baselines a device already offline on first sight and NEVER alerts for that outage', () => {
    const rules = [rule()];
    const first = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], emptyState(), T0);
    expect(first.events).toEqual([]);
    expect(first.changed).toBe(true);
    const tracked = first.state.get('SER-1')!;
    expect(tracked.status).toBe('down');
    expect(tracked.offlineSince).toBeNull();

    // Long past the threshold: still quiet — the outage start is unknowable.
    const later = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], first.state, T0 + 60 * MIN);
    expect(later.events).toEqual([]);
  });

  it('baselines a device discovered later exactly like a first-run device', () => {
    const rules = [rule()];
    const first = evaluateDeviceDownRules(rules, [dev()], emptyState(), T0);
    const discovered = evaluateDeviceDownRules(
      rules,
      [dev(), dev({ serial: 'SER-2', name: 'ap-3f-08', state: 'down' })],
      first.state,
      T0 + MIN,
    );
    expect(discovered.events).toEqual([]);
    expect(discovered.state.get('SER-2')!.offlineSince).toBeNull();
  });

  it('alerts for a NEW outage of a baseline-offline device once it has been seen up', () => {
    const rules = [rule({ offlineMinutes: 1, cooldownMinutes: 60 })];
    const first = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], emptyState(), T0);
    // Recovery of the baselined outage: no notice (it never alerted).
    const recovered = evaluateDeviceDownRules(rules, [dev()], first.state, T0 + MIN);
    expect(recovered.events).toEqual([]);
    // A fresh outage with a known start alerts after the threshold.
    const downAgain = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], recovered.state, T0 + 2 * MIN);
    expect(downAgain.events).toEqual([]);
    const fired = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], downAgain.state, T0 + 3 * MIN);
    expect(fired.events).toHaveLength(1);
    expect(fired.events[0]!.kind).toBe('fired');
  });
});

describe('evaluateDeviceDownRules — threshold and gates', () => {
  it('fires at the threshold, not before, and never twice for the same outage (gate 1)', () => {
    const rules = [rule({ offlineMinutes: 5 })];
    let state = emptyState();
    state = evaluateDeviceDownRules(rules, [dev()], state, T0).state; // baseline up
    const downAt = T0 + MIN;
    state = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], state, downAt).state;
    const beforeThreshold = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], state, downAt + 4 * MIN);
    expect(beforeThreshold.events).toEqual([]);
    const atThreshold = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], beforeThreshold.state, downAt + 5 * MIN);
    expect(atThreshold.events).toHaveLength(1);
    const fired = atThreshold.events[0]!;
    expect(fired.kind).toBe('fired');
    expect(fired.dedupKey).toBe(`SER-1@${new Date(downAt).toISOString()}`);
    expect(fired.offlineMinutes).toBe(5);
    // Gate 1: the same outage never re-fires.
    const repeat = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], atThreshold.state, downAt + 30 * MIN);
    expect(repeat.events).toEqual([]);
  });

  it('holds a new outage inside the previous alert’s cooldown window (gate 2), then fires', () => {
    const rules = [rule({ offlineMinutes: 1, cooldownMinutes: 60 })];
    let state = emptyState();
    state = evaluateDeviceDownRules(rules, [dev()], state, T0).state;
    state = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], state, T0 + MIN).state;
    const fired = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], state, T0 + 2 * MIN);
    expect(fired.events).toHaveLength(1);
    const recovered = evaluateDeviceDownRules(rules, [dev()], fired.state, T0 + 5 * MIN);
    expect(recovered.events.map((e) => e.kind)).toEqual(['recovered']);
    // New outage, threshold met — but only 10 minutes since the last alert.
    const downAgain = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], recovered.state, T0 + 10 * MIN);
    const blocked = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], downAgain.state, T0 + 11 * MIN);
    expect(blocked.events).toEqual([]);
    // The cooldown runs from the ALERT, so it expires at T0+62min.
    const cooledDown = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], blocked.state, T0 + 62 * MIN);
    expect(cooledDown.events).toHaveLength(1);
    expect(cooledDown.events[0]!.kind).toBe('fired');
    // A NEW outage is a NEW dedup key — that is what lets it fire at all.
    expect(cooledDown.events[0]!.dedupKey).not.toBe(fired.events[0]!.dedupKey);
  });

  it('sends recovery ONLY for outages that actually alerted', () => {
    const rules = [rule({ offlineMinutes: 5 })];
    let state = emptyState();
    state = evaluateDeviceDownRules(rules, [dev()], state, T0).state;
    // A short outage that never reached the threshold ends quietly.
    state = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], state, T0 + MIN).state;
    const quietEnd = evaluateDeviceDownRules(rules, [dev()], state, T0 + 2 * MIN);
    expect(quietEnd.events).toEqual([]);
  });

  it('still delivers the recovery when the rule was deleted mid-outage', () => {
    const rules = [rule({ offlineMinutes: 1 })];
    let state = emptyState();
    state = evaluateDeviceDownRules(rules, [dev()], state, T0).state;
    state = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], state, T0 + MIN).state;
    const fired = evaluateDeviceDownRules(rules, [dev({ state: 'down' })], state, T0 + 2 * MIN);
    expect(fired.events).toHaveLength(1);
    // The rule is gone; the operator was paged and still gets the all-clear.
    const recovered = evaluateDeviceDownRules([], [dev()], fired.state, T0 + 5 * MIN);
    expect(recovered.events).toHaveLength(1);
    expect(recovered.events[0]!.kind).toBe('recovered');
    expect(recovered.events[0]!.rule.id).toBe('arl-test');
  });
});

describe('selectRuleForDevice', () => {
  it('picks the most aggressive matching rule, breaking ties by lowest id', () => {
    const aggressive = rule({ id: 'arl-b', offlineMinutes: 5 });
    const lax = rule({ id: 'arl-a', offlineMinutes: 30 });
    expect(selectRuleForDevice([lax, aggressive], dev())!.id).toBe('arl-b');
    const tieA = rule({ id: 'arl-a', offlineMinutes: 5 });
    const tieB = rule({ id: 'arl-b', offlineMinutes: 5 });
    expect(selectRuleForDevice([tieB, tieA], dev())!.id).toBe('arl-a');
  });

  it('skips disabled rules and honors site and type filters', () => {
    expect(selectRuleForDevice([rule({ enabled: false })], dev())).toBeNull();
    expect(selectRuleForDevice([rule({ siteFilter: 'riverside' })], dev())).toBeNull();
    expect(selectRuleForDevice([rule({ siteFilter: 'CAMPUS-01' })], dev())!.id).toBe('arl-test');
    expect(selectRuleForDevice([rule({ siteFilter: 'campus-01 hq' })], dev())!.id).toBe('arl-test');
    expect(selectRuleForDevice([rule({ deviceTypeFilter: 'switch' })], dev())).toBeNull();
    expect(selectRuleForDevice([rule({ deviceTypeFilter: 'ap' })], dev())!.id).toBe('arl-test');
    expect(selectRuleForDevice([], dev())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('AlertRuleStore', () => {
  it('starts empty and persists rules and state across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-arl-store-'));
    try {
      const store = new AlertRuleStore(dir);
      expect(store.list()).toEqual([]);
      const created = store.create({ deviceTypeFilter: 'ap' }, T0);
      expect(created.id).toMatch(/^arl-/);
      expect(created.enabled).toBe(true);
      expect(created.offlineMinutes).toBe(DEFAULT_OFFLINE_MINUTES);
      expect(created.cooldownMinutes).toBe(DEFAULT_COOLDOWN_MINUTES);
      store.saveState(
        new Map([
          ['SER-1', { serial: 'SER-1', name: 'ap-1f-04', status: 'down', offlineSince: '2026-08-01T00:01:00.000Z', alertedFor: null, lastAlertedAt: null }],
        ]),
      );
      const reloaded = new AlertRuleStore(dir);
      expect(reloaded.list()).toHaveLength(1);
      expect(reloaded.stateSnapshot()['SER-1']!.offlineSince).toBe('2026-08-01T00:01:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the store file with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-arl-store-'));
    try {
      new AlertRuleStore(dir).create({}, T0);
      expect(statSync(join(dir, 'alert-rules.json')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies partial edits, clears filters, and is honest about unknown ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-arl-store-'));
    try {
      const store = new AlertRuleStore(dir);
      const created = store.create({ siteFilter: 'campus-01', deviceTypeFilter: 'ap', offlineMinutes: 10 }, T0);
      const updated = store.update(created.id, { offlineMinutes: 2, enabled: false });
      expect(updated!.offlineMinutes).toBe(2);
      expect(updated!.enabled).toBe(false);
      expect(updated!.siteFilter).toBe('campus-01');
      const cleared = store.update(created.id, { siteFilter: null, deviceTypeFilter: 'all' });
      expect(cleared!.siteFilter).toBeUndefined();
      expect(cleared!.deviceTypeFilter).toBeUndefined();
      expect(store.update('arl-nope', { enabled: false })).toBeNull();
      expect(store.remove('arl-nope')).toBeNull();
      expect(store.remove(created.id)!.id).toBe(created.id);
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a corrupt file as empty rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-arl-store-'));
    try {
      writeFileSync(join(dir, 'alert-rules.json'), 'not json{');
      const store = new AlertRuleStore(dir);
      expect(store.list()).toEqual([]);
      expect(store.stateSnapshot()).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

describe('AlertRulesService', () => {
  it('enqueues the incident before saving alerted state and leaves the transition retryable on enqueue failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-arl-incident-order-'));
    try {
      const store = new AlertRuleStore(dir);
      store.create({ offlineMinutes: 1, cooldownMinutes: 60 }, T0);
      let clock = T0;
      const devices = [dev()];
      const order: string[] = [];
      let failEnqueue = true;
      const incidentAutomation = {
        handleDeviceDownEvent: () => {
          order.push('enqueue');
          if (failEnqueue) throw new Error('outbox disk unavailable');
        },
      };
      const saveState = store.saveState.bind(store);
      store.saveState = (state) => {
        order.push('state');
        saveState(state);
      };
      const svc = new AlertRulesService({
        store,
        sampleDevices: () => devices,
        demoMode: () => false,
        nowMs: () => clock,
        dispatch: () => {},
        incidentAutomation,
      });
      await svc.evaluateNow();
      devices[0] = dev({ state: 'down' });
      clock = T0 + MIN;
      await svc.evaluateNow();
      order.length = 0;
      clock = T0 + 2 * MIN;
      await expect(svc.evaluateNow()).rejects.toThrow('outbox disk unavailable');
      expect(order).toEqual(['enqueue']);

      order.length = 0;
      failEnqueue = false;
      clock = T0 + 3 * MIN;
      expect(await svc.evaluateNow()).toHaveLength(1);
      expect(order).toEqual(['enqueue', 'state']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('baselines the first sample before it ever fires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-arl-svc-'));
    try {
      const store = new AlertRuleStore(dir);
      store.create({ offlineMinutes: 1 }, T0);
      const dispatched: DeviceDownEvent[] = [];
      const svc = new AlertRulesService({
        store,
        sampleDevices: () => [dev({ state: 'down' })],
        demoMode: () => false,
        nowMs: () => T0,
        dispatch: (event) => {
          dispatched.push(event);
        },
      });
      await svc.evaluateNow();
      expect(dispatched).toEqual([]);
      // The baseline persisted: a later evaluation long past the threshold
      // still says nothing about that first-seen outage.
      const stillQuiet = await svc.evaluateNow();
      expect(stillQuiet).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fires when the threshold is crossed, persists, and does not refire after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-arl-svc-'));
    try {
      const store = new AlertRuleStore(dir);
      store.create({ offlineMinutes: 1, cooldownMinutes: 60 }, T0);
      const dispatched: DeviceDownEvent[] = [];
      let clock = T0;
      const devices = [dev()];
      const svc = new AlertRulesService({
        store,
        sampleDevices: () => devices,
        demoMode: () => false,
        nowMs: () => clock,
        dispatch: (event) => {
          dispatched.push(event);
        },
      });
      await svc.evaluateNow(); // baseline up
      devices[0] = dev({ state: 'down' });
      clock = T0 + MIN;
      await svc.evaluateNow(); // outage starts
      clock = T0 + 2 * MIN;
      const firedEvents = await svc.evaluateNow();
      expect(firedEvents).toHaveLength(1);
      expect(dispatched.map((e) => e.kind)).toEqual(['fired']);
      // Restart: a new service over the same store sees the alerted outage
      // and stays quiet — the snapshot is restart-safe.
      const afterRestart: DeviceDownEvent[] = [];
      const svc2 = new AlertRulesService({
        store: new AlertRuleStore(dir),
        sampleDevices: () => devices,
        demoMode: () => false,
        nowMs: () => T0 + 30 * MIN,
        dispatch: (event) => {
          afterRestart.push(event);
        },
      });
      await svc2.evaluateNow();
      expect(afterRestart).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the demo showcase: fire on the first evaluation, recovery on the second, nothing persisted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-arl-svc-'));
    try {
      const dispatched: DeviceDownEvent[] = [];
      let clock = T0;
      const svc = new AlertRulesService({
        store: new AlertRuleStore(dir),
        sampleDevices: () => [],
        demoMode: () => true,
        nowMs: () => clock,
        dispatch: (event) => {
          dispatched.push(event);
        },
      });
      const first = await svc.evaluateNow();
      expect(first).toHaveLength(1);
      expect(first[0]!.kind).toBe('fired');
      expect(first[0]!.demo).toBe(true);
      expect(first[0]!.device.serial).toBe(DEMO_DEVICE_DOWN_DEVICE.serial);
      clock = T0 + MIN; // past the 30s scripted outage
      const second = await svc.evaluateNow();
      expect(second).toHaveLength(1);
      expect(second[0]!.kind).toBe('recovered');
      expect(second[0]!.demo).toBe(true);
      // The showcase never writes into the operator's data.
      const persisted = new AlertRuleStore(dir).stateSnapshot();
      expect(persisted[DEMO_DEVICE_DOWN_DEVICE.serial]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats duplicate sightings of one device as up-wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-arl-svc-'));
    try {
      const store = new AlertRuleStore(dir);
      store.create({ offlineMinutes: 1 }, T0);
      // The default sampler's dedupe is module-internal, so exercise the
      // engine with the deduped shape: one identity, seen down by one plane
      // and up by another, arrives as ONE up observation.
      const dispatched: DeviceDownEvent[] = [];
      let clock = T0;
      const sightings = [dev({ state: 'down' }), dev({ state: 'up', plane: 'MIST' })];
      const svc = new AlertRulesService({
        store,
        sampleDevices: () => {
          const byIdentity = new Map<string, ObservedDevice[]>();
          for (const row of sightings) {
            const group = byIdentity.get(row.serial) ?? [];
            group.push(row);
            byIdentity.set(row.serial, group);
          }
          return [...byIdentity.values()].map(
            (group) => group.find((row) => !deviceIsOffline(row.state)) ?? group[0]!,
          );
        },
        demoMode: () => false,
        nowMs: () => clock,
        dispatch: (event) => {
          dispatched.push(event);
        },
      });
      await svc.evaluateNow();
      clock = T0 + 5 * MIN;
      await svc.evaluateNow();
      expect(dispatched).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe('alert-rules routes', () => {
  it('GET serves an empty list when no rules exist', async () => {
    const { status, body } = await getJson('/api/alert-rules');
    expect(status).toBe(200);
    expect(body.rules).toEqual([]);
  });

  it('POST refuses invalid minutes, unknown type filters and empty site filters', async () => {
    for (const payload of [
      { offlineMinutes: 0 },
      { offlineMinutes: 1441 },
      { cooldownMinutes: 1.5 },
      { offlineMinutes: '5' },
      { deviceTypeFilter: 'nonsense' },
      { siteFilter: '   ' },
      { enabled: 'yes' },
    ]) {
      const { status, body } = await sendJson('POST', '/api/alert-rules', payload);
      expect(status).toBe(400);
      expect(typeof body.error).toBe('string');
    }
    expect(alertRuleStore.list()).toEqual([]);
  });

  it('POST creates with defaults, normalizes type aliases, and audits', async () => {
    const { status, body } = await sendJson('POST', '/api/alert-rules', { deviceTypeFilter: 'Switches' });
    expect(status).toBe(201);
    expect(body.rule.id).toMatch(/^arl-/);
    expect(body.rule.enabled).toBe(true);
    expect(body.rule.offlineMinutes).toBe(5);
    expect(body.rule.cooldownMinutes).toBe(60);
    expect(body.rule.deviceTypeFilter).toBe('switch');
    const events = auditEvents().filter((e) => e.event === 'alert-rule-created');
    expect(events).toHaveLength(1);
    expect(events[0]!.ticket).toBe('—');
    expect(events[0]!.changeId).toBe(body.rule.id);
  });

  it('PUT edits partially, 404s unknown ids, and audits', async () => {
    const created = await sendJson('POST', '/api/alert-rules', { offlineMinutes: 10 });
    const id = created.body.rule.id;
    const missing = await sendJson('PUT', '/api/alert-rules/arl-nope', { enabled: false });
    expect(missing.status).toBe(404);
    const { status, body } = await sendJson('PUT', `/api/alert-rules/${id}`, { enabled: false, cooldownMinutes: 120 });
    expect(status).toBe(200);
    expect(body.rule.enabled).toBe(false);
    expect(body.rule.cooldownMinutes).toBe(120);
    expect(body.rule.offlineMinutes).toBe(10);
    const invalid = await sendJson('PUT', `/api/alert-rules/${id}`, { offlineMinutes: 0 });
    expect(invalid.status).toBe(400);
    expect(auditEvents().some((e) => e.event === 'alert-rule-updated' && e.changeId === id)).toBe(true);
  });

  it('PUT clears the site filter with null (the keep/clear/replace tri-state)', async () => {
    const created = await sendJson('POST', '/api/alert-rules', { siteFilter: 'campus-01' });
    const id = created.body.rule.id;
    expect(created.body.rule.siteFilter).toBe('campus-01');
    const { status, body } = await sendJson('PUT', `/api/alert-rules/${id}`, { siteFilter: null });
    expect(status).toBe(200);
    expect(body.rule.siteFilter).toBeUndefined();
    const blank = await sendJson('PUT', `/api/alert-rules/${id}`, { siteFilter: '' });
    expect(blank.status).toBe(400);
  });

  it('DELETE removes, 404s unknown ids, and audits', async () => {
    const created = await sendJson('POST', '/api/alert-rules', {});
    const id = created.body.rule.id;
    const missing = await sendJson('DELETE', '/api/alert-rules/arl-nope');
    expect(missing.status).toBe(404);
    const { status, body } = await sendJson('DELETE', `/api/alert-rules/${id}`);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(auditEvents().some((e) => e.event === 'alert-rule-deleted' && e.changeId === id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full-stack dispatch: the real singletons, no injected seams
// ---------------------------------------------------------------------------

describe('the demo showcase through the REAL dispatch path', () => {
  it('fires into the notifier outbox, the bell and the audit log on the first evaluation', async () => {
    // Demo mode is the settings default (HPE_SETTINGS_PATH points at a
    // nonexistent tmp file), and the singleton engine's first evaluateNow is
    // this test's — the showcase's first evaluation.
    const endpoint = notificationStore.create({
      name: 'hooks',
      url: 'https://hooks.example.com/alerts',
      template: 'generic',
      enabled: true,
    });
    try {
      const events = await alertRulesService.evaluateNow();
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('fired');
      expect(events[0]!.demo).toBe(true);

      // The notifier hook: the fire rides the existing fired/resolved path,
      // so the endpoint lights up — in demo mode, as an outbox payload.
      const outbox = notifier.outbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.event.kind).toBe('fired');
      expect(outbox[0]!.event.device).toBe(DEMO_DEVICE_DOWN_DEVICE.name);
      expect(outbox[0]!.event.fingerprint).toBe(events[0]!.dedupKey);
      expect(outbox[0]!.demo).toBe(true);

      // The bell: one demo-labelled unread entry, and the showcase's device
      // links nowhere (it is not in the inventory).
      const bell = notificationCenter.list();
      expect(bell.unread).toBe(1);
      expect(bell.entries[0]!.demo).toBe(true);
      expect(bell.entries[0]!.severity).toBe('danger');
      expect(bell.entries[0]!.url).toBeUndefined();

      // The audit log names the fire, ticket '—'.
      const fired = auditEvents().filter((e) => e.event === 'device-down-alert');
      expect(fired).toHaveLength(1);
      expect(fired[0]!.ticket).toBe('—');
      expect(fired[0]!.changeId).toBe(events[0]!.dedupKey);

      // Gate 1 survives the real dispatch too: a second evaluation inside the
      // scripted outage adds nothing anywhere.
      await alertRulesService.evaluateNow();
      expect(notifier.outbox()).toHaveLength(1);
      expect(notificationCenter.list().unread).toBe(1);
      expect(auditEvents().filter((e) => e.event === 'device-down-alert')).toHaveLength(1);
    } finally {
      notificationStore.remove(endpoint.id);
    }
  });
});
