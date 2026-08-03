import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertRow, DeviceDownEvent, WebhookReceivedEvent } from '@hpe/shared';
import { IncidentAutomation, clientIncidentKey, deviceDownIncidentKey } from '../src/services/incidentAutomation';
import { TicketStore } from '../src/services/tickets';

const ALERT: AlertRow = {
  sev: 'P2',
  tone: 'warning',
  title: 'Device offline',
  detail: 'ap-1f-04 has been offline for 5m',
  siteId: 'campus-01',
  siteName: 'Campus-01 HQ',
  plane: 'CENTRAL',
  state: 'open',
  age: '5m',
  device: 'ap-1f-04',
};

const DEVICE_EVENT: DeviceDownEvent = {
  kind: 'fired',
  dedupKey: 'SER-1@2026-08-03T12:00:00.000Z',
  rule: { id: 'arl-1', offlineMinutes: 5, cooldownMinutes: 60 },
  device: {
    serial: 'SER-1',
    name: 'ap-1f-04',
    type: 'ap',
    state: 'down',
    siteId: 'campus-01',
    siteName: 'Campus-01 HQ',
    plane: 'CENTRAL',
  },
  outageStart: '2026-08-03T12:00:00.000Z',
  offlineMinutes: 5,
  at: '2026-08-03T12:05:00.000Z',
};

function webhookEvent(overrides: Partial<WebhookReceivedEvent> = {}): WebhookReceivedEvent {
  return {
    id: 'evt-client-1',
    source: 'mist',
    receivedAt: '2026-08-03T12:05:01.000Z',
    eventType: 'alarms:client_health',
    demo: false,
    sev: 'P1',
    title: 'Client health failure',
    detail: 'structured failure episode received',
    state: 'open',
    device: 'tablet-7',
    siteId: 'campus-01',
    siteName: 'Campus-01 HQ',
    eventAt: '2026-08-03T12:05:00.000Z',
    clientFailure: {
      mac: 'aa:bb:cc:dd:ee:ff',
      failureClass: 'authentication',
      episodeStartedAt: '2026-08-03T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('TicketStore incident persistence', () => {
  let dir: string;
  let store: TicketStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hpe-incident-ticket-'));
    store = new TicketStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists an exact incident fingerprint and deduplicates it across restart', () => {
    const input = {
      key: 'device-down:SER-1@2026-08-03T12:00:00.000Z',
      kind: 'device-down' as const,
      source: 'alert-rules' as const,
      episodeStartedAt: '2026-08-03T12:00:00.000Z',
      observedAt: '2026-08-03T12:05:00.000Z',
      alert: ALERT,
    };
    const first = store.upsertIncident(input)!;
    expect(first.incident).toEqual({
      key: input.key,
      kind: 'device-down',
      source: 'alert-rules',
      episodeStartedAt: input.episodeStartedAt,
    });

    const afterRestart = new TicketStore(dir);
    expect(afterRestart.upsertIncident(input)!.id).toBe(first.id);
    expect(afterRestart.list()).toHaveLength(1);
  });

  it('does not use title/device dedupe for automated incidents and preserves manual raises', () => {
    const base = {
      kind: 'device-down' as const,
      source: 'alert-rules' as const,
      observedAt: '2026-08-03T12:05:00.000Z',
      alert: ALERT,
    };
    const first = store.upsertIncident({
      ...base,
      key: 'device-down:SER-1@2026-08-03T12:00:00.000Z',
      episodeStartedAt: '2026-08-03T12:00:00.000Z',
    })!;
    const second = store.upsertIncident({
      ...base,
      key: 'device-down:SER-1@2026-08-03T14:00:00.000Z',
      episodeStartedAt: '2026-08-03T14:00:00.000Z',
    })!;
    const manual = store.raiseFromAlert(ALERT);

    expect(new Set([first.id, second.id, manual.id]).size).toBe(3);
    expect(store.list()).toHaveLength(3);
    expect(manual.incident).toBeUndefined();
  });

  it('resolves and notes only the exact automated incident', () => {
    const make = (key: string) =>
      store.upsertIncident({
        key,
        kind: 'device-down',
        source: 'alert-rules',
        episodeStartedAt: key.slice('device-down:SER-1@'.length),
        observedAt: '2026-08-03T12:05:00.000Z',
        alert: ALERT,
      })!;
    const exact = make('device-down:SER-1@2026-08-03T12:00:00.000Z');
    const other = make('device-down:SER-1@2026-08-03T14:00:00.000Z');
    const manual = store.raiseFromAlert(ALERT);

    const resolved = store.resolveIncident(exact.incident!.key, 'Device recovered after 17m offline');
    expect(resolved?.state).toBe('resolved');
    expect(resolved?.notes).toEqual([
      expect.objectContaining({ kind: 'action', text: 'Device recovered after 17m offline' }),
    ]);
    expect(store.list().find((t) => t.id === other.id)?.state).toBe('open');
    expect(store.list().find((t) => t.id === manual.id)?.state).toBe('open');
    expect(store.resolveIncident(exact.incident!.key, 'duplicate recovery')?.notes).toHaveLength(1);
    expect(store.resolveIncident('device-down:missing', 'not applicable')).toBeNull();
  });

});

describe('IncidentAutomation', () => {
  let dir: string;
  let store: TicketStore;
  let automation: IncidentAutomation;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hpe-incident-automation-'));
    store = new TicketStore(dir);
    automation = new IncidentAutomation(store, { dataDir: dir, intervalMs: 10 });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keys a device-down episode from the canonical DeviceDownEvent and resolves that exact outage', () => {
    expect(deviceDownIncidentKey(DEVICE_EVENT)).toBe('device-down:SER-1@2026-08-03T12:00:00.000Z');
    automation.handleDeviceDownEvent(DEVICE_EVENT);
    automation.handleDeviceDownEvent(DEVICE_EVENT);
    expect(store.list()).toHaveLength(1);

    automation.handleDeviceDownEvent({ ...DEVICE_EVENT, kind: 'recovered', offlineMinutes: 17, at: '2026-08-03T12:17:00.000Z' });
    expect(store.list()[0]).toMatchObject({ state: 'resolved', incident: { key: deviceDownIncidentKey(DEVICE_EVENT) } });
    expect(store.list()[0].notes?.[0]?.text).toContain('17m');
  });

  it('keys client failures only from canonical plane, normalized MAC, failure class, and episode start', () => {
    const event = webhookEvent();
    expect(clientIncidentKey(event)).toBe(
      'client-health:MIST:aabbccddeeff:authentication:2026-08-03T12:00:00.000Z',
    );
    automation.handleWebhookEvent(event);
    automation.handleWebhookEvent({ ...event, id: 'evt-redelivery' });
    expect(store.list()).toHaveLength(1);

    automation.handleWebhookEvent(webhookEvent({ id: 'evt-clear', state: 'cleared' }));
    expect(store.list()[0].state).toBe('resolved');
  });

  it('ignores demo data, client session telemetry, and webhook presentation fields without explicit failure metadata', () => {
    automation.handleDeviceDownEvent({ ...DEVICE_EVENT, demo: true });
    automation.handleWebhookEvent(webhookEvent({ demo: true }));
    automation.handleWebhookEvent(
      webhookEvent({
        id: 'evt-session',
        eventType: 'client-sessions:disconnect',
        title: 'Client health critical',
        detail: 'authentication failure',
        sev: 'P1',
        clientFailure: undefined,
      }),
    );
    automation.handleWebhookEvent(
      webhookEvent({
        id: 'evt-warning-only',
        eventType: 'alarms:warning',
        title: 'Client unhealthy',
        detail: 'failure-looking presentation text',
        sev: 'P1',
        clientFailure: undefined,
      }),
    );
    expect(store.list()).toEqual([]);
    expect(clientIncidentKey(webhookEvent({ clientFailure: undefined }))).toBeNull();
  });

  it('persists one terminal lifecycle command so recovery-before-open survives restart', () => {
    const recovery = webhookEvent({ id: 'evt-clear-first', state: 'cleared' });
    automation.handleWebhookEvent(recovery);

    const restarted = new IncidentAutomation(new TicketStore(dir), { dataDir: dir });
    restarted.handleWebhookEvent(webhookEvent({ id: 'evt-open-late', state: 'open' }));

    expect(new TicketStore(dir).list()).toEqual([]);
    expect(restarted.lifecycleSnapshot()).toEqual([
      expect.objectContaining({
        key: clientIncidentKey(recovery),
        desiredState: 'resolved',
        appliedState: 'resolved',
        attempts: 1,
        lastError: null,
      }),
    ]);
    expect(statSync(join(dir, 'incident-lifecycle-outbox.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps a failed ticket mutation durable and retries it independently on startup', () => {
    let mutations = 0;
    const failingTickets = {
      upsertIncident: () => {
        mutations += 1;
        throw new Error('tickets disk unavailable');
      },
      resolveIncident: () => null,
    };
    const first = new IncidentAutomation(failingTickets, { dataDir: dir, intervalMs: 10 });
    first.handleDeviceDownEvent(DEVICE_EVENT);
    expect(first.lifecycleSnapshot()).toEqual([
      expect.objectContaining({
        key: deviceDownIncidentKey(DEVICE_EVENT),
        desiredState: 'open',
        appliedState: 'none',
        attempts: 1,
        lastError: 'tickets disk unavailable',
      }),
    ]);

    const restarted = new IncidentAutomation(new TicketStore(dir), { dataDir: dir, intervalMs: 10 });
    restarted.start(); // immediate drain, independent of alert sampling/notification
    restarted.stop();

    expect(mutations).toBe(1);
    expect(new TicketStore(dir).list()).toHaveLength(1);
    expect(restarted.lifecycleSnapshot()[0]).toMatchObject({
      desiredState: 'open',
      appliedState: 'open',
      attempts: 2,
      lastError: null,
    });
  });

  it('drains pending commands on its own retry interval', async () => {
    vi.useFakeTimers();
    let fail = true;
    const target = {
      upsertIncident: (input: Parameters<TicketStore['upsertIncident']>[0]) => {
        if (fail) throw new Error('tickets disk unavailable');
        return store.upsertIncident(input);
      },
      resolveIncident: (key: string, note: string) => store.resolveIncident(key, note),
    };
    const timed = new IncidentAutomation(target, { dataDir: dir, intervalMs: 10 });
    try {
      timed.handleDeviceDownEvent(DEVICE_EVENT); // initial mutation fails, enqueue survives
      timed.start(); // immediate retry also fails
      fail = false;
      await vi.advanceTimersByTimeAsync(10);
      expect(store.list()).toHaveLength(1);
      expect(timed.lifecycleSnapshot()[0]).toMatchObject({ appliedState: 'open', attempts: 3 });
    } finally {
      timed.stop();
      vi.useRealTimers();
    }
  });

  it('fails closed when the outbox is unreadable instead of mutating tickets without a durable command', () => {
    const file = join(dir, 'incident-lifecycle-outbox.json');
    const first = new IncidentAutomation(store, { dataDir: dir });
    first.handleDeviceDownEvent(DEVICE_EVENT);
    expect(readFileSync(file, 'utf8')).toContain(deviceDownIncidentKey(DEVICE_EVENT));
    rmSync(join(dir, 'tickets.json'));
    // A new instance must not treat corrupted ordering state as empty.
    writeFileSync(file, 'not json{');
    const closed = new IncidentAutomation(new TicketStore(dir), { dataDir: dir });
    expect(() => closed.handleDeviceDownEvent({ ...DEVICE_EVENT, dedupKey: 'SER-2@2026-08-03T12:00:00.000Z' }))
      .toThrow(/unreadable incident lifecycle outbox/);
    expect(new TicketStore(dir).list()).toEqual([]);
  });
});
