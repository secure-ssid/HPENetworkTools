/**
 * server/tests/mistWebhooks.test.ts — the Mist webhook auto-registration.
 *
 * The service (services/mistWebhooks.ts) is exercised with an injected
 * plane/receiver/dataDir, no registry and no app: the reviewed upsert
 * (create vs update vs unchanged), the validation refusals (before ANY
 * call), the rotate ordering (the receiver re-arms only AFTER the org write
 * lands), the re-read verification, and the audit line that never carries
 * the secret. The routes (routes/hooks.ts) are covered against a real app
 * for the review gate and the demo-labelled answers.
 *
 * HPE_SETTINGS_PATH / HPE_DATA_DIR point at a tmp dir before any src/ module
 * is imported — the same harness as webhookReceiver.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MistWebhookRegistrationForm, MistWebhookSubscription } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let dataDir: string;
let mistWebhookRegistrationStatus: typeof import('../src/services/mistWebhooks').mistWebhookRegistrationStatus;
let registerMistWebhook: typeof import('../src/services/mistWebhooks').registerMistWebhook;
let WebhookReceiver: typeof import('../src/services/webhookReceiver').WebhookReceiver;
let ReceiverSecretStore: typeof import('../src/services/webhookReceiver').ReceiverSecretStore;
type MistWebhookPlane = import('../src/services/mistWebhooks').MistWebhookPlane;

const URL = 'https://portal.meridian-health.example/api/hooks/mist';
const TOPICS = ['alarms', 'client-sessions', 'device-updowns'] as const;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-mistwh-'));
  dataDir = join(tmpDir, 'data');
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = dataDir;
  const mod = await import('../src/services/mistWebhooks');
  mistWebhookRegistrationStatus = mod.mistWebhookRegistrationStatus;
  registerMistWebhook = mod.registerMistWebhook;
  const receiverMod = await import('../src/services/webhookReceiver');
  WebhookReceiver = receiverMod.WebhookReceiver;
  ReceiverSecretStore = receiverMod.ReceiverSecretStore;
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

function subscription(over: Partial<MistWebhookSubscription> = {}): MistWebhookSubscription {
  return {
    id: 'wh-1',
    name: 'hpe-network-tools receiver',
    url: URL,
    topics: [...TOPICS],
    enabled: true,
    secretConfigured: true,
    ...over,
  };
}

/** An injectable plane recording its calls; list/write behaviour per test. */
function fakePlane(opts: {
  list?: MistWebhookSubscription[] | null;
  listSequence?: (MistWebhookSubscription[] | null)[];
  writeOk?: boolean;
  writeHttpCode?: number;
}) {
  const listCalls: { kind: 'list' }[] = [];
  const writeCalls: { kind: 'write'; existingId: string | null; form: Record<string, unknown> }[] = [];
  let listIdx = 0;
  const plane: MistWebhookPlane = {
    async listMistWebhooks() {
      listCalls.push({ kind: 'list' });
      if (opts.listSequence) {
        const answer = opts.listSequence[Math.min(listIdx, opts.listSequence.length - 1)];
        listIdx += 1;
        return answer;
      }
      // undefined → an empty org; null → the read FAILED (a different fact).
      return opts.list === undefined ? [] : opts.list;
    },
    async writeMistWebhook(existingId, form) {
      writeCalls.push({ kind: 'write', existingId, form: form as Record<string, unknown> });
      const ok = opts.writeOk ?? true;
      return {
        httpCode: opts.writeHttpCode ?? (ok ? 200 : 500),
        ok,
        subscription: ok ? subscription({ url: form.url, topics: form.topics }) : null,
      };
    },
  };
  return { plane, listCalls, writeCalls };
}

function isolatedReceiver(dir: string) {
  return new WebhookReceiver({
    dataDir: dir,
    secrets: new ReceiverSecretStore(dir),
    demoMode: () => false,
  });
}

function auditLines(dir: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(dir, 'change-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function form(over: Partial<MistWebhookRegistrationForm> = {}): MistWebhookRegistrationForm {
  return { url: URL, topics: [...TOPICS], ...over };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe('mistWebhookRegistrationStatus', () => {
  it('serves the authored fixture in demo mode, with the receiver’s real last-received stamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mistwh-st-'));
    try {
      const receiver = isolatedReceiver(dir);
      const status = await mistWebhookRegistrationStatus({ demoMode: () => true, receiver });
      expect(status.demo).toBe(true);
      expect(status.linked).toBe(true);
      expect(status.subscriptions).toHaveLength(1);
      expect(status.subscriptions[0].url).toContain('/api/hooks/mist');
      expect(status.subscriptions[0].topics).toEqual([...TOPICS]);
      expect(status.lastReceivedAt).toBeNull(); // nothing received yet — explicit, not absent
      expect(JSON.stringify(status)).not.toContain('demo-webhook-receiver-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says not-linked when no Mist plane can answer', async () => {
    const status = await mistWebhookRegistrationStatus({ demoMode: () => false, plane: null });
    expect(status.linked).toBe(false);
    expect(status.error).toContain('not linked');
    expect(status.subscriptions).toEqual([]);
  });

  it('an unreadable subscription list is an honest error, never an empty state', async () => {
    const { plane } = fakePlane({ list: null });
    const status = await mistWebhookRegistrationStatus({ demoMode: () => false, plane });
    expect(status.error).toContain('could not read');
    expect(status.totalSubscriptions).toBeNull();
  });

  it('filters the subscriptions pointing at this receiver and counts the rest', async () => {
    const { plane } = fakePlane({
      list: [
        subscription(),
        subscription({ id: 'wh-2', url: 'https://servicenow.example.com/hooks/mist' }),
        subscription({ id: 'wh-3', url: 'https://other-host.example/api/hooks/mist' }), // also ours
      ],
    });
    const status = await mistWebhookRegistrationStatus({ demoMode: () => false, plane });
    expect(status.subscriptions.map((s) => s.id)).toEqual(['wh-1', 'wh-3']);
    expect(status.totalSubscriptions).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The reviewed register / rotate / verify write
// ---------------------------------------------------------------------------

describe('registerMistWebhook', () => {
  it('refuses an invalid URL, a URL off the receiver path, a bad topic and a short secret — before ANY call', async () => {
    const { plane, listCalls, writeCalls } = fakePlane({});
    const opts = { demoMode: () => false, plane };
    for (const bad of [
      form({ url: 'http://portal.example.com/api/hooks/mist' }),
      form({ url: 'https://portal.example.com/somewhere/else' }),
      form({ url: 'https://portal.example.com/api/hooks/mist', topics: ['nac-events' as never] }),
      form({ url: 'https://portal.example.com/api/hooks/mist', secret: 'short' }),
      form({ url: '' }),
    ]) {
      const result = await registerMistWebhook(bad, opts);
      expect(result.ok).toBe(false);
      expect(result.action).toBe('failed');
    }
    expect(listCalls).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
  });

  it('answers the canned demo result without touching the plane or the audit log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mistwh-demo-'));
    try {
      const { plane, listCalls } = fakePlane({});
      const result = await registerMistWebhook(form(), { demoMode: () => true, plane, dataDir: dir });
      expect(result).toMatchObject({ ok: true, action: 'created', demo: true, verified: true });
      expect(listCalls).toHaveLength(0);
      expect(auditLines(dir)).toHaveLength(0); // nothing changed — auditing a demo would be the lie
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write when the existing subscriptions cannot be read — a blind create could duplicate one', async () => {
    const { plane, writeCalls } = fakePlane({ list: null });
    const result = await registerMistWebhook(form(), { demoMode: () => false, plane });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('could not read');
    expect(writeCalls).toHaveLength(0);
  });

  it('is idempotent: same URL, same topics, enabled, no secret rotation → unchanged, no write', async () => {
    const { plane, writeCalls } = fakePlane({ list: [subscription()] });
    const result = await registerMistWebhook(form(), { demoMode: () => false, plane });
    expect(result).toMatchObject({ ok: true, action: 'unchanged', verified: true });
    expect(writeCalls).toHaveLength(0);
  });

  it('POSTs a create when no subscription carries the URL, verifies by re-read, and audits WITHOUT the secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mistwh-cr-'));
    try {
      const receiver = isolatedReceiver(dir);
      const { plane, writeCalls } = fakePlane({
        listSequence: [[], [subscription()]], // pre-write list empty; post-write re-read shows it
      });
      const result = await registerMistWebhook(form({ secret: 'rotate-me-secret-123' }), {
        demoMode: () => false,
        plane,
        receiver,
        dataDir: dir,
      });
      expect(result).toMatchObject({ ok: true, action: 'created', verified: true });
      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0].existingId).toBeNull();
      expect(writeCalls[0].form.secret).toBe('rotate-me-secret-123');
      // The receiver re-armed so deliveries verify…
      expect(receiver.effectiveSecret('mist')?.secret).toBe('rotate-me-secret-123');
      // …and the audit line records the rotation ROLE, never the value.
      const lines = auditLines(dir);
      expect(lines.some((e) => e.event === 'mist-webhook-registration' && String(e.result).includes('rotated'))).toBe(true);
      expect(JSON.stringify(lines)).not.toContain('rotate-me-secret-123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PUTs an update when the URL is registered with different topics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mistwh-up-'));
    try {
      const { plane, writeCalls } = fakePlane({
        listSequence: [
          [subscription({ topics: ['alarms'] })],
          [subscription()],
        ],
      });
      const result = await registerMistWebhook(form(), { demoMode: () => false, plane, dataDir: dir });
      expect(result).toMatchObject({ ok: true, action: 'updated', verified: true });
      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0].existingId).toBe('wh-1');
      expect(writeCalls[0].form).not.toHaveProperty('secret');
      const lines = auditLines(dir);
      expect(lines.some((e) => e.event === 'mist-webhook-registration' && String(e.result).includes('updated'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('arms the receiver secret only AFTER the org write lands — a failed write arms nothing and audits nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mistwh-fail-'));
    try {
      const receiver = isolatedReceiver(dir);
      const { plane, writeCalls } = fakePlane({ list: [], writeOk: false, writeHttpCode: 403 });
      const result = await registerMistWebhook(form({ secret: 'never-armed-secret' }), {
        demoMode: () => false,
        plane,
        receiver,
        dataDir: dir,
      });
      expect(result).toMatchObject({ ok: false, action: 'failed', httpCode: 403 });
      expect(writeCalls).toHaveLength(1);
      expect(receiver.effectiveSecret('mist')).toBeNull(); // still nothing to verify against
      expect(auditLines(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a write the re-read cannot confirm is reported unverified, never claimed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mistwh-unv-'));
    try {
      const { plane } = fakePlane({ listSequence: [[], null] }); // re-read fails after a 200 write
      const result = await registerMistWebhook(form(), { demoMode: () => false, plane, dataDir: dir });
      expect(result.ok).toBe(true);
      expect(result.verified).toBeUndefined();
      expect(result.message).toContain('did not show it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The routes — the review gate and the demo answers, against a real app
// ---------------------------------------------------------------------------

describe('the registration routes', () => {
  it('POST /api/hooks/mist/registration requires the review confirmation', async () => {
    const res = await fetch(`${base}/api/hooks/mist/registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: URL }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).message).toContain('review confirmation');
  });

  it('POST with the review answers the demo-labelled result in demo mode', async () => {
    const res = await fetch(`${base}/api/hooks/mist/registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: URL, reviewConfirmed: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, action: 'created', demo: true });
    expect((body.subscription as Record<string, unknown>).url).toBe(URL);
  });

  it('GET /api/hooks/mist/registration serves the demo fixture in demo mode', async () => {
    const res = await fetch(`${base}/api/hooks/mist/registration`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.demo).toBe(true);
    expect((body.subscriptions as unknown[]).length).toBe(1);
  });
});
