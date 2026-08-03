/**
 * server/tests/webhookReceiver.test.ts — the inbound webhook receiver.
 *
 * HPE_SETTINGS_PATH / HPE_DATA_DIR point at a tmp dir so the test never
 * touches real data/; the env vars are set before any src/ module is
 * imported (the singletons resolve their dir at construction), so everything
 * loads with dynamic imports inside beforeAll — the same harness
 * silences.test.ts uses.
 *
 * Covered:
 *   HMAC     — Mist v2 (SHA-256) and v1 (SHA-1) accept, wrong secret and
 *              missing headers reject 401; New Central RFC 9421 signature
 *              accepts (including the https-behind-a-proxy scheme variant),
 *              tampered/missing rejects 401;
 *   raw body — a signature over the exact bytes sent verifies even with
 *              non-canonical JSON whitespace, and a signature over a
 *              RE-SERIALIZED body fails (proof the raw parser is in play);
 *   malformed— invalid JSON, a bare scalar, and an event-less envelope all
 *              answer 400 with a valid signature;
 *   secrets  — store 0600 + persistence, route set/clear with audit lines,
 *              503 when nothing is configured outside demo mode;
 *   normalize— Mist alarms envelope and New Central alert notification into
 *              honest AlertRow-shaped events (severity/state/site/device);
 *   bounds   — ring caps, jsonl appends, rotation across generations,
 *              restart hydration, redelivery dedupe;
 *   pipeline — a simulated delivery lands in /api/alerts through the SAME
 *              group/silence path, and the simulate route 403s outside demo.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WEBHOOK_DEMO_RECEIVER_SECRET, type WebhookReceivedEvent } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let dataDir: string;
let WebhookReceiver: typeof import('../src/services/webhookReceiver').WebhookReceiver;
let ReceiverSecretStore: typeof import('../src/services/webhookReceiver').ReceiverSecretStore;
let signMistDelivery: typeof import('../src/services/webhookReceiver').signMistDelivery;
let signCentralDelivery: typeof import('../src/services/webhookReceiver').signCentralDelivery;
let webhookEventToAlertRow: typeof import('../src/services/webhookReceiver').webhookEventToAlertRow;
let silenceStore: typeof import('../src/services/silences').silenceStore;
let settings: typeof import('../src/config/settings').settings;
type WebhookReceiverInstance = InstanceType<typeof WebhookReceiver>;
type RequestCtx = import('../src/services/webhookReceiver').ReceiverRequestContext;

const MIST_ALARM = {
  topic: 'alarms',
  events: [
    {
      id: 'mist-alarm-1',
      type: 'rogue_ap',
      severity: 'warn',
      timestamp: 1780000000,
      site_name: 'Campus-01 HQ',
      aps: ['5c5b35000042'],
      count: 2,
    },
  ],
};

const CENTRAL_ALERT = {
  alertId: 'central-alert-1',
  name: 'Switch disconnected',
  summary: 'Device sw-edge-2 disconnected',
  category: 'device',
  state: 'Open',
  severity: 'Critical',
  time: '2026-05-29T10:00:00.000Z',
  impactedEntities: { deviceSerial: ['SG00001'] },
  additionalDetails: [{ site: 'Campus-01 HQ' }],
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-hooks-'));
  dataDir = join(tmpDir, 'data');
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = dataDir;
  const mod = await import('../src/services/webhookReceiver');
  WebhookReceiver = mod.WebhookReceiver;
  ReceiverSecretStore = mod.ReceiverSecretStore;
  signMistDelivery = mod.signMistDelivery;
  signCentralDelivery = mod.signCentralDelivery;
  webhookEventToAlertRow = mod.webhookEventToAlertRow;
  ({ silenceStore } = await import('../src/services/silences'));
  ({ settings } = await import('../src/config/settings'));
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
  // The route tests share the singleton silence store; leave it empty.
  for (const s of silenceStore.list()) silenceStore.remove(s.id);
  if (!settings.get().demoMode) settings.update({ demoMode: true });
});

function port(): number {
  return (server.address() as AddressInfo).port;
}

function mistPost(raw: string, secret: string = WEBHOOK_DEMO_RECEIVER_SECRET): Promise<Response> {
  return fetch(`${base}/api/hooks/mist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signMistDelivery(secret, Buffer.from(raw, 'utf8')) },
    body: raw,
  });
}

function centralCtx(overrides: Partial<RequestCtx> = {}): RequestCtx {
  return {
    method: 'POST',
    path: '/api/hooks/central',
    query: '',
    protocol: 'http',
    host: `127.0.0.1:${port()}`,
    ...overrides,
  };
}

function centralPost(
  raw: string,
  secret: string = WEBHOOK_DEMO_RECEIVER_SECRET,
  ctx: RequestCtx = centralCtx(),
): Promise<Response> {
  return fetch(`${base}/api/hooks/central`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signCentralDelivery(secret, ctx) },
    body: raw,
  });
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

/** res.json() without the unknown cast ceremony — these tests assert values. */
async function anyJson(res: Response): Promise<any> {
  return res.json();
}

/** An isolated receiver with its own tmp dir — unit tests never share the
 *  route tests' singleton. */
function isolatedReceiver(opts: {
  ringSize?: number;
  rotationPolicy?: { maxBytes: number; keep: number };
  demoMode?: boolean;
  incidentAutomation?: { handleWebhookEvent(event: WebhookReceivedEvent): void };
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hpe-hooks-unit-'));
  const receiver = new WebhookReceiver({
    dataDir: dir,
    secrets: new ReceiverSecretStore(dir),
    demoMode: () => opts.demoMode ?? true,
    ...(opts.ringSize !== undefined ? { ringSize: opts.ringSize } : {}),
    ...(opts.rotationPolicy ? { rotationPolicy: opts.rotationPolicy } : {}),
    ...(opts.incidentAutomation ? { incidentAutomation: opts.incidentAutomation } : {}),
  });
  return { dir, receiver };
}

function ingestMist(receiver: WebhookReceiverInstance, payload: unknown, secret = WEBHOOK_DEMO_RECEIVER_SECRET) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const signed = signMistDelivery(secret, raw);
  return receiver.ingest('mist', raw, (name) => signed[name], centralCtx({ path: '/api/hooks/mist' }));
}

// ---------------------------------------------------------------------------
// HMAC verification — Mist
// ---------------------------------------------------------------------------

describe('Mist signature verification', () => {
  it('accepts a delivery signed with the v2 (SHA-256) header', async () => {
    const res = await mistPost(JSON.stringify({ topic: 'alarms', events: [{ ...MIST_ALARM.events[0], id: 'mist-v2-ok' }] }));
    expect(res.status).toBe(202);
    expect((await anyJson(res)).accepted).toBe(1);
  });

  it('accepts a delivery carrying only the v1 (SHA-1) header', async () => {
    const { createHmac } = await import('node:crypto');
    const raw = JSON.stringify({ topic: 'alarms', events: [{ ...MIST_ALARM.events[0], id: 'mist-v1-ok' }] });
    const v1 = createHmac('sha1', WEBHOOK_DEMO_RECEIVER_SECRET).update(raw).digest('hex');
    const res = await fetch(`${base}/api/hooks/mist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mist-signature': v1 },
      body: raw,
    });
    expect(res.status).toBe(202);
  });

  it('rejects a wrong secret with 401', async () => {
    const res = await mistPost(JSON.stringify(MIST_ALARM), 'the-wrong-secret');
    expect(res.status).toBe(401);
    expect((await anyJson(res)).error).toContain('signature verification failed');
  });

  it('rejects a missing signature with 401', async () => {
    const res = await fetch(`${base}/api/hooks/mist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(MIST_ALARM),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a garbage signature with 401', async () => {
    const res = await fetch(`${base}/api/hooks/mist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mist-signature-v2': 'not-a-hex-digest' },
      body: JSON.stringify(MIST_ALARM),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// HMAC verification — New Central (RFC 9421)
// ---------------------------------------------------------------------------

describe('New Central signature verification', () => {
  it('accepts a correctly signed delivery', async () => {
    const res = await centralPost(JSON.stringify({ ...CENTRAL_ALERT, alertId: 'central-ok-1' }));
    expect(res.status).toBe(202);
    expect((await anyJson(res)).accepted).toBe(1);
  });

  it('accepts a delivery signed for https while arriving as http (TLS terminated in front)', async () => {
    const res = await centralPost(
      JSON.stringify({ ...CENTRAL_ALERT, alertId: 'central-ok-https' }),
      WEBHOOK_DEMO_RECEIVER_SECRET,
      centralCtx({ protocol: 'https' }),
    );
    expect(res.status).toBe(202);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const res = await centralPost(JSON.stringify(CENTRAL_ALERT), 'the-wrong-secret');
    expect(res.status).toBe(401);
  });

  it('rejects a signature that does not cover the request authority', async () => {
    const res = await centralPost(
      JSON.stringify(CENTRAL_ALERT),
      WEBHOOK_DEMO_RECEIVER_SECRET,
      centralCtx({ host: 'some-other-host.example' }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a delivery with no signature headers', async () => {
    const res = await fetch(`${base}/api/hooks/central`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CENTRAL_ALERT),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an algorithm other than hmac-sha256', async () => {
    const res = await fetch(`${base}/api/hooks/central`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'signature-input': 'sig1=("@method");created=1700000000;alg="hs2019"',
        signature: 'sig1=:AAAA:',
      },
      body: JSON.stringify(CENTRAL_ALERT),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Raw-body parsing
// ---------------------------------------------------------------------------

describe('raw-body parsing', () => {
  it('verifies over the exact bytes sent, whitespace and all', async () => {
    const pretty = `{\n  "topic" : "alarms",\n  "events" : [ ${JSON.stringify({ ...MIST_ALARM.events[0], id: 'mist-raw-pretty' })}\n  ]\n}`;
    const res = await mistPost(pretty);
    expect(res.status).toBe(202);
  });

  it('fails a signature computed over a re-serialized (different-byte) body', async () => {
    const payload = { topic: 'alarms', events: [{ ...MIST_ALARM.events[0], id: 'mist-raw-mismatch' }] };
    const sent = `{\n  "topic":"alarms",  "events":[${JSON.stringify(payload.events[0])} ] }`;
    // Sign the MINIFIED form, send the spaced form: any implementation that
    // re-serializes before verifying would wrongly accept this.
    const res = await fetch(`${base}/api/hooks/mist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signMistDelivery(WEBHOOK_DEMO_RECEIVER_SECRET, Buffer.from(JSON.stringify(payload), 'utf8')),
      },
      body: sent,
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Malformed bodies (all correctly signed)
// ---------------------------------------------------------------------------

describe('malformed deliveries', () => {
  it('answers 400 for invalid JSON', async () => {
    const res = await mistPost('{"topic": "alarms", "events": [');
    expect(res.status).toBe(400);
    expect((await anyJson(res)).error).toContain('malformed JSON');
  });

  it('answers 400 for a JSON scalar', async () => {
    const res = await mistPost('42');
    expect(res.status).toBe(400);
    expect((await anyJson(res)).error).toContain('no recognizable events');
  });

  it('answers 400 for an envelope with no events', async () => {
    const res = await mistPost(JSON.stringify({ topic: 'alarms', events: [] }));
    expect(res.status).toBe(400);
  });

  it('answers 400 for a Central payload with no recognizable fields', async () => {
    const res = await centralPost(JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe('normalization', () => {
  it('emits incident automation only for a newly accepted explicit client failure episode', () => {
    const automated: WebhookReceivedEvent[] = [];
    const { dir, receiver } = isolatedReceiver({
      demoMode: false,
      incidentAutomation: { handleWebhookEvent: (event) => automated.push(event) },
    });
    try {
      receiver.setSecret('mist', WEBHOOK_DEMO_RECEIVER_SECRET);
      const payload = {
        topic: 'alarms',
        events: [{
          id: 'client-health-1',
          type: 'client_health',
          state: 'open',
          mac: 'AA-BB-CC-DD-EE-FF',
          failure_class: 'Authentication Failure',
          episode_start: '2026-08-03T12:00:00.000Z',
          timestamp: '2026-08-03T12:05:00.000Z',
          title: 'presentation is not identity',
          severity: 'critical',
        }],
      };
      const first = ingestMist(receiver, payload);
      const replay = ingestMist(receiver, payload);
      const recovered = ingestMist(receiver, {
        topic: 'alarms',
        events: [{ ...payload.events[0], id: 'client-health-1-recovered', state: 'Recovered' }],
      });

      expect(first.body.accepted).toBe(1);
      expect(replay.body).toMatchObject({ accepted: 0, deduplicated: 1 });
      expect(recovered.body.accepted).toBe(1);
      expect(automated).toHaveLength(2);
      expect(automated[0].clientFailure).toEqual({
        mac: 'aa:bb:cc:dd:ee:ff',
        failureClass: 'authentication-failure',
        episodeStartedAt: '2026-08-03T12:00:00.000Z',
      });
      expect(automated[1]).toMatchObject({ state: 'cleared', clientFailure: automated[0].clientFailure });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not canonicalize client sessions or presentation-only warnings as client incidents', () => {
    const automated: WebhookReceivedEvent[] = [];
    const { dir, receiver } = isolatedReceiver({
      incidentAutomation: { handleWebhookEvent: (event) => automated.push(event) },
    });
    try {
      ingestMist(receiver, {
        topic: 'client-sessions',
        events: [{
          id: 'session-disconnect',
          type: 'disconnect',
          mac: 'AA-BB-CC-DD-EE-FF',
          failure_class: 'authentication',
          episode_start: '2026-08-03T12:00:00.000Z',
          termination_reason: 'authentication failure',
          timestamp: '2026-08-03T12:05:00.000Z',
        }],
      });
      ingestMist(receiver, {
        topic: 'alarms',
        events: [{
          id: 'warning-only',
          type: 'client_warning',
          state: 'warning',
          mac: 'AA-BB-CC-DD-EE-FF',
          title: 'Client health failure',
          severity: 'critical',
          timestamp: '2026-08-03T12:05:00.000Z',
        }],
      });

      expect(automated).toHaveLength(2); // newly accepted records still reach the automation boundary
      expect(automated.every((event) => event.clientFailure === undefined)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a Mist alarms event into an honest received event', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      const outcome = ingestMist(receiver, MIST_ALARM);
      expect(outcome.status).toBe(202);
      const [event] = receiver.recent();
      expect(event).toMatchObject({
        source: 'mist',
        eventType: 'alarms:rogue_ap',
        sev: 'P2', // 'warn' → P2, the poller's own severity mapping
        title: 'Rogue Ap',
        state: 'open',
        device: '5c5b35000042',
        siteId: 'campus-01',
        alertId: 'mist-alarm-1',
        demo: true, // verified against the public demo secret — labelled
      });
      expect(event.eventAt).toBe(new Date(1780000000 * 1000).toISOString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes every event of a multi-event Mist envelope', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      const outcome = ingestMist(receiver, {
        topic: 'alarms',
        events: [
          { ...MIST_ALARM.events[0], id: 'multi-1' },
          { ...MIST_ALARM.events[0], id: 'multi-2', type: 'device_down', severity: 'crit' },
        ],
      });
      expect(outcome.status).toBe(202);
      expect(outcome.body.accepted).toBe(2);
      const events = receiver.recent();
      expect(events).toHaveLength(2);
      expect(events[0].sev).toBe('P1'); // 'crit' → P1; newest first
      expect(events[0].title).toBe('Device Down');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a New Central alert notification into an honest received event', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      const raw = Buffer.from(JSON.stringify(CENTRAL_ALERT), 'utf8');
      const ctx = centralCtx();
      const signed = signCentralDelivery(WEBHOOK_DEMO_RECEIVER_SECRET, ctx);
      const outcome = receiver.ingest('central', raw, (name) => signed[name], ctx);
      expect(outcome.status).toBe(202);
      const [event] = receiver.recent();
      expect(event).toMatchObject({
        source: 'central',
        eventType: 'device',
        sev: 'P1', // 'Critical' → P1
        title: 'Switch disconnected',
        state: 'open',
        device: 'sw-edge-2', // the summary's leading 'Device <name>' pattern
        siteId: 'campus-01',
        alertId: 'central-alert-1',
        demo: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a Cleared Central state through, never as open', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      const raw = Buffer.from(JSON.stringify({ ...CENTRAL_ALERT, state: 'Cleared' }), 'utf8');
      const ctx = centralCtx();
      const signed = signCentralDelivery(WEBHOOK_DEMO_RECEIVER_SECRET, ctx);
      const outcome = receiver.ingest('central', raw, (name) => signed[name], ctx);
      expect(outcome.status).toBe(202);
      expect(receiver.recent()[0].state).toBe('cleared');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a client-sessions roam — next_ap is the roam word, the client is the device', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      const outcome = ingestMist(receiver, {
        topic: 'client-sessions',
        events: [
          {
            id: 'cs-roam-1',
            type: 'connect',
            mac: '3c:22:fb:41:0a:19',
            hostname: 'okonjo-ipad',
            ssid: 'MRDN-Clinical',
            ap: 'ap-3f-12',
            next_ap: 'ap-3f-14',
            band: '5',
            channel: 36,
            rssi: -58,
            timestamp: 1780000000,
            site_name: 'Campus-01 HQ',
          },
        ],
      });
      expect(outcome.status).toBe(202);
      const [event] = receiver.recent();
      expect(event).toMatchObject({
        source: 'mist',
        eventType: 'client-sessions:roam',
        sev: 'P3', // session telemetry, never an invented alarm
        title: 'Client roamed',
        state: 'open',
        device: 'okonjo-ipad',
        siteId: 'campus-01',
        alertId: 'cs-roam-1',
      });
      expect(event.detail).toContain('ssid MRDN-Clinical');
      expect(event.detail).toContain('ap ap-3f-12');
      expect(event.detail).toContain('→ ap-3f-14');
      expect(event.detail).toContain('rssi -58 dBm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a client-sessions disconnect with its termination reason', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      ingestMist(receiver, {
        topic: 'client-sessions',
        events: [
          {
            id: 'cs-disc-1',
            type: 'disconnect',
            mac: 'de:ad:0b:14:65:22',
            username: 's.mehta',
            ssid: 'MRDN-Clinical',
            ap: 'ap-3f-14',
            termination_reason: 'inactivity timeout',
            timestamp: 1780000000,
          },
        ],
      });
      const [event] = receiver.recent();
      expect(event).toMatchObject({ eventType: 'client-sessions:disconnect', title: 'Client disconnected', device: 's.mehta' });
      expect(event.detail).toContain('reason: inactivity timeout');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a device-updowns down as the firing and up as the cleared recovery', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      ingestMist(receiver, {
        topic: 'device-updowns',
        events: [
          { id: 'du-down-1', type: 'down', device_name: 'ap-3f-14', mac: '3c:52:82:3f:14:01', model: 'AP43', timestamp: 1780000000, site_name: 'Campus-01 HQ' },
        ],
      });
      ingestMist(receiver, {
        topic: 'device-updowns',
        events: [
          { id: 'du-up-1', type: 'up', device_name: 'ap-3f-14', mac: '3c:52:82:3f:14:01', timestamp: 1780000300, site_name: 'Campus-01 HQ' },
        ],
      });
      const events = receiver.recent();
      expect(events).toHaveLength(2);
      const [up, down] = events;
      expect(down).toMatchObject({ eventType: 'device-updowns:down', title: 'Device down', sev: 'P2', state: 'open', device: 'ap-3f-14' });
      expect(down?.detail).toContain('AP43');
      expect(up).toMatchObject({ eventType: 'device-updowns:up', title: 'Device up', sev: 'P3', state: 'cleared', device: 'ap-3f-14' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dedupes a redelivered topic event with no event id by mac+type+timestamp', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      const delivery = {
        topic: 'device-updowns',
        events: [{ type: 'down', device_name: 'ap-3f-14', mac: '3c:52:82:3f:14:01', timestamp: 1780000000 }],
      };
      expect(ingestMist(receiver, delivery).status).toBe(202);
      const second = ingestMist(receiver, delivery);
      expect(second.body.accepted).toBe(0);
      expect(second.body.deduplicated).toBe(1);
      // …but a NEW incident (a later timestamp) is a new event, not a retry.
      const third = ingestMist(receiver, {
        topic: 'device-updowns',
        events: [{ type: 'down', device_name: 'ap-3f-14', mac: '3c:52:82:3f:14:01', timestamp: 1780001000 }],
      });
      expect(third.body.accepted).toBe(1);
      expect(receiver.recent()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a clientless session event records generically (the vendor’s own words); a wholly unrecognizable payload 400s', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      // No mac: the dedicated mapper cannot say WHO, so the event records
      // through the generic mapper — a signed event is never dropped for
      // being thin, it is recorded with exactly what it said.
      const noClient = ingestMist(receiver, { topic: 'client-sessions', events: [{ type: 'connect', ssid: 'x' }] });
      expect(noClient.status).toBe(202);
      expect(receiver.recent()[0]).toMatchObject({ eventType: 'client-sessions:connect', title: 'Connect' });
      const empty = ingestMist(receiver, { topic: 'client-sessions', events: [{}] });
      expect(empty.status).toBe(400); // nothing recognizable in the payload
      const odd = ingestMist(receiver, {
        topic: 'device-updowns',
        events: [{ id: 'du-odd-1', type: 'flapping', device: 'ap-x' }],
      });
      expect(odd.status).toBe(202);
      expect(receiver.recent()[0]).toMatchObject({ eventType: 'device-updowns:flapping', title: 'Flapping' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('projects an event to an AlertRow with the delivering plane and source marker', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      ingestMist(receiver, MIST_ALARM);
      const row = webhookEventToAlertRow(receiver.recent()[0], Date.parse('2026-05-29T12:00:00.000Z'));
      expect(row).toMatchObject({
        sev: 'P2',
        tone: 'warning',
        plane: 'MIST',
        source: 'webhook',
        state: 'open',
        siteId: 'campus-01',
      });
      // Age derives from the source's own event stamp at read time.
      expect(row.age).not.toBe('—');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ring + jsonl bounds
// ---------------------------------------------------------------------------

describe('the bounded record', () => {
  it('caps the in-memory ring while the jsonl keeps appending', () => {
    const { dir, receiver } = isolatedReceiver({ ringSize: 3 });
    try {
      for (let i = 0; i < 5; i += 1) {
        expect(ingestMist(receiver, { topic: 'alarms', events: [{ ...MIST_ALARM.events[0], id: `ring-${i}` }] }).status).toBe(202);
      }
      const events = receiver.recent();
      expect(events).toHaveLength(3);
      expect(events[0].alertId).toBe('ring-4'); // newest first
      const lines = readFileSync(join(dir, 'webhook-events.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hydrates from the log across a restart, reading across rotated generations', () => {
    const { dir, receiver } = isolatedReceiver({ rotationPolicy: { maxBytes: 700, keep: 5 } });
    try {
      for (let i = 0; i < 8; i += 1) {
        ingestMist(receiver, { topic: 'alarms', events: [{ ...MIST_ALARM.events[0], id: `rot-${i}` }] });
      }
      // Rotation really happened: more than just the live file is on disk.
      const generations = readdirSync(dir).filter((f) => f.startsWith('webhook-events'));
      expect(generations.length).toBeGreaterThan(1);
      // A fresh instance over the same dir is the restart: the ring rebuilds
      // from the log, generations included, so nothing appears to vanish.
      const restarted = new WebhookReceiver({
        dataDir: dir,
        secrets: new ReceiverSecretStore(dir),
        demoMode: () => true,
        rotationPolicy: { maxBytes: 700, keep: 5 },
      });
      const events = restarted.recent();
      expect(events).toHaveLength(8);
      expect(events[0].alertId).toBe('rot-7');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a vendor redelivery idempotently instead of recording it twice', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      expect(ingestMist(receiver, MIST_ALARM).status).toBe(202);
      const second = ingestMist(receiver, MIST_ALARM);
      expect(second.status).toBe(202);
      expect(second.body.deduplicated).toBe(1);
      expect(second.body.accepted).toBe(0);
      expect(receiver.recent()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a Central Open→Cleared transition as a new firing, not a duplicate', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      for (const state of ['Open', 'Cleared']) {
        const raw = Buffer.from(JSON.stringify({ ...CENTRAL_ALERT, state }), 'utf8');
        const ctx = centralCtx();
        const signed = signCentralDelivery(WEBHOOK_DEMO_RECEIVER_SECRET, ctx);
        expect(receiver.ingest('central', raw, (name) => signed[name], ctx).status).toBe(202);
      }
      expect(receiver.recent()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('receiver secrets', () => {
  it('persists the store with mode 0600 across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-hooks-sec-'));
    try {
      new ReceiverSecretStore(dir).set('mist', 'a-real-mist-secret');
      expect(statSync(join(dir, 'webhook-receivers.json')).mode & 0o777).toBe(0o600);
      expect(new ReceiverSecretStore(dir).get('mist')?.secret).toBe('a-real-mist-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies against a stored operator secret instead of the demo secret', () => {
    const { dir, receiver } = isolatedReceiver();
    try {
      receiver.setSecret('mist', 'operator-mist-secret');
      // The demo secret no longer verifies…
      expect(ingestMist(receiver, MIST_ALARM).status).toBe(401);
      // …the operator's does, and the event is NOT demo-labelled.
      expect(ingestMist(receiver, MIST_ALARM, 'operator-mist-secret').status).toBe(202);
      expect(receiver.recent()[0].demo).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers 503 outside demo mode with nothing configured', () => {
    const { dir, receiver } = isolatedReceiver({ demoMode: false });
    try {
      const outcome = ingestMist(receiver, MIST_ALARM);
      expect(outcome.status).toBe(503);
      expect(String(outcome.body.error)).toContain('no mist webhook signing secret is configured');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('set/clear via the routes, with audit lines and write-only responses', async () => {
    const bad = await fetch(`${base}/api/hooks/receivers/mist/secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'short' }),
    });
    expect(bad.status).toBe(400);

    const set = await fetch(`${base}/api/hooks/receivers/mist/secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'route-set-mist-secret' }),
    });
    expect(set.status).toBe(200);
    const setBody = await set.json();
    expect(setBody).toMatchObject({ ok: true, source: 'mist', secret: 'operator' });
    expect(JSON.stringify(setBody)).not.toContain('route-set-mist-secret');

    // The stored secret is what deliveries now verify against.
    expect((await mistPost(JSON.stringify({ topic: 'alarms', events: [{ ...MIST_ALARM.events[0], id: 'route-sec-1' }] }))).status).toBe(401);
    expect(
      (await mistPost(JSON.stringify({ topic: 'alarms', events: [{ ...MIST_ALARM.events[0], id: 'route-sec-1' }] }), 'route-set-mist-secret')).status,
    ).toBe(202);
    // Status reports the configured state.
    const status = await getJson('/api/hooks/receivers');
    expect(status.body.receivers.find((r: any) => r.source === 'mist').secret).toBe('operator');

    const audit = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.some((e) => e.event === 'webhook-receiver-secret-set')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('route-set-mist-secret');

    const cleared = await fetch(`${base}/api/hooks/receivers/mist/secret`, { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect((await getJson('/api/hooks/receivers')).body.receivers.find((r: any) => r.source === 'mist').secret).toBe('demo');
    const again = await fetch(`${base}/api/hooks/receivers/mist/secret`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The demo simulate path + the alerts pipeline union
// ---------------------------------------------------------------------------

describe('the simulate path and the alert queue', () => {
  it('posts a fixture through the real signed pipeline and into the queue', async () => {
    const sim = await fetch(`${base}/api/hooks/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'mist' }),
    });
    expect(sim.status).toBe(202);
    const simBody: any = await sim.json();
    expect(simBody.accepted).toBe(1);
    expect(simBody.demo).toBe(true);

    // The receiver status now names a last-received instant…
    const status = await getJson('/api/hooks/receivers');
    const mist = status.body.receivers.find((r: any) => r.source === 'mist');
    expect(mist.lastReceivedAt).not.toBeNull();
    expect(mist.receivedCount).toBeGreaterThan(0);

    // …the events endpoint lists it, demo-labelled…
    const events = await getJson('/api/hooks/events');
    const received = (events.body.events as WebhookReceivedEvent[]).find((e) => e.title === 'Rogue Ap');
    expect(received).toBeDefined();
    expect(received!.demo).toBe(true);

    // …and /api/alerts serves it through the SAME queue view as polled rows.
    const alerts = await getJson('/api/alerts');
    const row = (alerts.body.alerts as any[]).find((a) => a.title === 'Rogue Ap' && a.source === 'webhook');
    expect(row).toMatchObject({ plane: 'MIST', sev: 'P2', state: 'open' });
    expect((alerts.body.groups as any[]).some((g) => g.latest.title === 'Rogue Ap')).toBe(true);
  });

  it('benches a received event under an active silence like any other firing', async () => {
    await fetch(`${base}/api/hooks/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'central' }),
    });
    const silenced = await fetch(`${base}/api/silences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titleContains: 'Switch disconnected', reason: 'known — webhook pipeline check', durationMinutes: 60 }),
    });
    expect(silenced.status).toBe(201);
    const alerts = await getJson('/api/alerts');
    expect((alerts.body.alerts as any[]).some((a) => a.title === 'Switch disconnected')).toBe(false);
    const benched = (alerts.body.silenced as any[]).find((s) => s.group.latest.title === 'Switch disconnected');
    expect(benched.silence.reason).toBe('known — webhook pipeline check');
  });

  it('refuses to simulate outside demo mode, and says why', async () => {
    settings.update({ demoMode: false });
    const res = await fetch(`${base}/api/hooks/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'mist' }),
    });
    expect(res.status).toBe(403);
    expect((await anyJson(res)).error).toContain('demo mode');
  });

  it('validates the simulate source', async () => {
    const res = await fetch(`${base}/api/hooks/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'greenlake' }),
    });
    expect(res.status).toBe(400);
  });

  it('simulates the client-sessions and device-updowns topics through the same signed path', async () => {
    const roam = await fetch(`${base}/api/hooks/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'mist', topic: 'client-sessions' }),
    });
    expect(roam.status).toBe(202);
    expect((await anyJson(roam)).accepted).toBe(1);

    const down = await fetch(`${base}/api/hooks/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'mist', topic: 'device-updowns' }),
    });
    expect(down.status).toBe(202);

    // Both land in the alert queue through the SAME group/silence path —
    // the roam as session telemetry, the device down as the P2 firing.
    const alerts = await getJson('/api/alerts');
    const rows = alerts.body.alerts as any[];
    expect(rows.some((a) => a.title === 'Client roamed' && a.source === 'webhook' && a.sev === 'P3')).toBe(true);
    expect(rows.some((a) => a.title === 'Device down' && a.device === 'ap-3f-14' && a.sev === 'P2' && a.state === 'open')).toBe(true);
  });

  it('refuses a topic the receiver has no mapper for', async () => {
    const res = await fetch(`${base}/api/hooks/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'mist', topic: 'nac-events' }),
    });
    expect(res.status).toBe(400);
    expect((await anyJson(res)).error).toContain('topic');
  });
});

// ---------------------------------------------------------------------------
// The queue-view helper
// ---------------------------------------------------------------------------

describe('withWebhookAlerts', () => {
  it('prepends received rows and returns the input untouched when empty', async () => {
    const { withWebhookAlerts } = await import('../src/routes/screens/webhookAlerts');
    const { dir, receiver } = isolatedReceiver();
    try {
      const base_row = webhookEventToAlertRow(
        {
          id: 'evt-base',
          source: 'mist',
          receivedAt: new Date().toISOString(),
          eventType: 'alarms:device_down',
          demo: false,
          sev: 'P3',
          title: 'Base row',
          detail: '',
          state: 'open',
          device: '',
          siteId: 'campus-01',
          siteName: 'Campus-01',
          eventAt: null,
        },
        Date.now(),
      );
      expect(withWebhookAlerts([base_row], receiver)).toEqual([base_row]);
      ingestMist(receiver, MIST_ALARM);
      const merged = withWebhookAlerts([base_row], receiver);
      expect(merged).toHaveLength(2);
      expect(merged[0].title).toBe('Rogue Ap');
      expect(merged[1]).toEqual(base_row);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
