/**
 * server/src/services/notifier.ts — outbound alert notifications.
 *
 * Watches the same alert queue the /api/alerts route serves (sampled through
 * alertQueueView, so a silenced group is quiet here exactly as it is on
 * screen) and pushes group-level transitions — fired / resolved / escalated,
 * shared/notifications.ts defines all three — to the operator's configured
 * endpoints: a generic JSON webhook, Slack, Teams or ntfy.
 *
 * The disciplines are the repo's own, copied deliberately:
 *
 *   - BOUNDED. One unref'd interval (never keeps the process alive), one
 *     sample at a time (a slow receiver never stacks up behind the timer),
 *     a bounded attempt count with fixed backoff, a per-request timeout, and
 *     a bounded in-memory demo outbox. Nothing here grows or waits without a
 *     ceiling.
 *   - SSRF. Every URL passes validateCallbackUrl (shared/webhooks.ts) at
 *     create/update time in the route AND again at send time here: the file
 *     can be hand-edited between the two, and a config check is evidence of a
 *     point-in-time decision, not a standing guarantee. A refused URL is a
     recorded, audited failure — never a silent skip.
 *   - HONEST FAILURE. Every attempt's final outcome is persisted on the
 *     endpoint (notifierStore.recordDelivery) and audit-logged through the
 *     same append-only change log as the brokered writes. A failure that
 *     only lived in memory would be laundered by every restart.
 *   - DEMO MODE NEVER DIALS. With demoMode on, no network call is made under
 *     any circumstances: the rendered would-have-sent payload lands in a
 *     visible in-memory outbox (GET /api/notifications/outbox) labelled demo,
 *     and the delivery record says 'demo', never 'delivered'.
 *
 * The first sample after start() is a BASELINE: it establishes what is
 * already firing without notifying, or every boot would re-page the whole
 * standing queue at every endpoint.
 */

import { createHmac, randomBytes } from 'node:crypto';
import {
  ALERTS,
  NOTIFICATION_SIGNATURE_HEADER,
  diffAlertGroups,
  renderNotification,
  validateCallbackUrl,
  type AlertGroup,
  type AlertRow,
  type NotificationDelivery,
  type NotificationEndpoint,
  type NotificationEvent,
  type NotificationOutboxEntry,
  type NotificationSampleState,
  type NotificationServiceStatus,
} from '@hpe/shared';
import { effectiveSectionSource, settings } from '../config/settings';
import { poller } from './poller';
import { alertQueueView } from './silences';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { notificationStore, type NotificationStore } from './notifierStore';

/** How the /api/alerts route picks its rows: the section's effective source,
 *  with the blend swap when demo+blendLive and a plane has reported. The
 *  notifier must watch the SAME queue the operator is looking at, or a
 *  transition on screen and a transition in the inbox would disagree. */
function defaultSampleAlerts(): AlertRow[] {
  const s = settings.get();
  const live: AlertRow[] = [];
  for (const [, pull] of poller.contributionsByPlane()) {
    if (pull.alerts) live.push(...pull.alerts);
  }
  if (effectiveSectionSource(s, 'alerts') === 'demo') {
    const blend = s.blendLive === true && s.sectionMode?.alerts !== 'demo';
    return blend && live.length > 0 ? live : ALERTS;
  }
  return live;
}

export interface NotifierOptions {
  store?: NotificationStore; // default: the process-wide singleton
  sampleAlerts?: () => AlertRow[]; // default: the same source decision as /api/alerts
  demoMode?: () => boolean; // default: the settings store
  intervalMs?: number; // default 30s
  fetchImpl?: typeof fetch; // default: global fetch (tests inject a spy)
  sleep?: (ms: number) => Promise<void>; // default: real timer (tests inject a recorder)
  nowMs?: () => number; // injected clock for tests
  maxAttempts?: number; // total attempts per send, default 3
  backoffMs?: readonly number[]; // between attempts, default [1000, 4000]
  timeoutMs?: number; // per-request, default 10s
  dataDir?: string; // audit-log destination, default: HPE_DATA_DIR or <repo>/data
  outboxCapacity?: number; // demo outbox ring size, default 100
  /**
   * Lets the delivery-time URL check pass for http/loopback targets so tests
   * can POST to a capture server. Hard-gated on NODE_ENV=test, exactly the
   * centralWebhooks.ts seam — request bodies and real config can never opt
   * out of the SSRF rule.
   */
  allowInsecureUrlForTests?: boolean;
}

/** The honest answer a test send returns: what actually happened, verbatim. */
export interface NotificationTestResult {
  ok: boolean;
  message: string;
  demo?: boolean;
  httpCode?: number;
  ms: number;
}

export class Notifier {
  private readonly store: NotificationStore;
  private readonly sampleAlerts: () => AlertRow[];
  private readonly demoMode: () => boolean;
  private readonly intervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly maxAttempts: number;
  private readonly backoffMs: readonly number[];
  private readonly timeoutMs: number;
  private readonly dataDir: string;
  private readonly outboxCapacity: number;
  private readonly allowInsecureUrlForTests: boolean;

  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private previous: NotificationSampleState | null = null;
  private lastSampleAt: string | null = null;
  private outboxEntries: NotificationOutboxEntry[] = [];

  constructor(opts: NotifierOptions = {}) {
    this.store = opts.store ?? notificationStore;
    this.sampleAlerts = opts.sampleAlerts ?? defaultSampleAlerts;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.backoffMs = opts.backoffMs ?? [1_000, 4_000];
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.outboxCapacity = opts.outboxCapacity ?? 100;
    this.allowInsecureUrlForTests =
      process.env.NODE_ENV === 'test' && opts.allowInsecureUrlForTests === true;
  }

  /** One immediate (baseline) sample plus one per interval — the poller's
   *  own rule: the timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sampleNow();
    }, this.intervalMs);
    this.timer.unref();
    void this.sampleNow();
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

  /** What GET /api/notifications/status serves. */
  status(): NotificationServiceStatus {
    return {
      demoMode: this.demoMode(),
      sampling: {
        running: this.isRunning(),
        lastSampleAt: this.lastSampleAt,
        trackedGroups: this.previous?.groups.size ?? 0,
      },
      endpoints: this.store.list().map((e) => ({ id: e.id, delivery: e.delivery ?? null })),
    };
  }

  /** The demo outbox, newest first. Always [] in live mode — it only fills
   *  when demo mode swallowed a would-have-sent payload. */
  outbox(): NotificationOutboxEntry[] {
    return [...this.outboxEntries];
  }

  /**
   * Sample the queue, diff against the previous sample, and dispatch every
   * transition to every enabled endpoint. The FIRST sample establishes the
   * baseline and sends nothing (see the header). One sample at a time: a
   * slow receiver must never let two samples overlap.
   */
  async sampleNow(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const now = this.nowMs();
      const view = alertQueueView(this.sampleAlerts(), now);
      const current = {
        active: view.groups,
        silenced: view.silenced.map((s) => s.group),
      };
      this.lastSampleAt = new Date(now).toISOString();
      const previous = this.previous;
      this.previous = stateOf(current);
      if (previous === null) return; // baseline — no boot storm
      for (const transition of diffAlertGroups(previous, current)) {
        const event = this.eventFor(transition.kind, transition.group, transition.previousCount, now);
        for (const endpoint of this.store.list()) {
          if (endpoint.enabled) await this.deliver(endpoint, event);
        }
      }
    } finally {
      this.sampling = false;
    }
  }

  /**
   * Deliver one EXTERNALLY produced event — the device-down rules engine's
   * fires and recoveries (services/alertRules.ts) — to every enabled
   * endpoint, down the same render/sign/deliver path as queue transitions.
   * Demo mode swallows to the outbox here exactly as it does for the queue.
   */
  async dispatch(event: NotificationEvent): Promise<void> {
    for (const endpoint of this.store.list()) {
      if (endpoint.enabled) await this.deliver(endpoint, event);
    }
  }

  /**
   * One event to one endpoint: render, sign, POST with bounded retry, record
   * the outcome. Never throws — a failing endpoint is a recorded fact, not
   * an exception that could take the sampler down with it. `budget` caps the
   * attempts: the sampler spends the full retry policy, a test send spends
   * one attempt because a human is waiting on the answer.
   */
  async deliver(
    endpoint: NotificationEndpoint,
    event: NotificationEvent,
    test = false,
    budget: number = this.maxAttempts,
  ): Promise<NotificationDelivery> {
    const attemptedAt = new Date(this.nowMs()).toISOString();
    const tag = test ? 'test send — ' : '';
    const rendered = renderNotification(endpoint.template, event);

    if (this.demoMode()) {
      this.pushOutbox({
        id: `out-${this.nowMs().toString(36)}${randomBytes(3).toString('hex')}`,
        at: attemptedAt,
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        event,
        contentType: rendered.contentType,
        body: rendered.body,
        demo: true,
      });
      const delivery: NotificationDelivery = { lastAttemptAt: attemptedAt, lastResult: 'demo' };
      this.store.recordDelivery(endpoint.id, delivery);
      this.audit('notification-demo', event, endpoint, `${tag}demo mode — no network call; payload is in the outbox`);
      return delivery;
    }

    // Send-time SSRF check: the route validated at save time, but the file
    // can change between the two, and this process may have started with an
    // already-stored row. A refused URL is recorded, never quietly skipped.
    const check = this.allowInsecureUrlForTests ? { ok: true as const } : validateCallbackUrl(endpoint.url);
    if (!check.ok) {
      const delivery: NotificationDelivery = {
        lastAttemptAt: attemptedAt,
        lastResult: 'failed',
        lastError: `refused — ${check.reason ?? 'invalid URL'}`,
      };
      this.store.recordDelivery(endpoint.id, delivery);
      this.audit('notification-failed', event, endpoint, `${tag}${delivery.lastError}`);
      return delivery;
    }

    const headers: Record<string, string> = { 'content-type': rendered.contentType };
    if (endpoint.hmacSecret) {
      const signature = createHmac('sha256', endpoint.hmacSecret).update(rendered.body).digest('hex');
      headers[NOTIFICATION_SIGNATURE_HEADER] = `sha256=${signature}`;
    }

    let lastError = 'no attempt made';
    let httpCode: number | undefined;
    let attempts = 0;
    for (let attempt = 1; attempt <= budget; attempt += 1) {
      attempts = attempt;
      try {
        const res = await this.fetchImpl(endpoint.url, {
          method: 'POST',
          headers,
          body: rendered.body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        httpCode = res.status;
        if (res.ok) {
          const delivery: NotificationDelivery = {
            lastAttemptAt: attemptedAt,
            lastResult: 'delivered',
            httpCode: res.status,
          };
          this.store.recordDelivery(endpoint.id, delivery);
          this.audit(
            'notification-sent',
            event,
            endpoint,
            `${tag}HTTP ${res.status}${attempt > 1 ? ` after ${attempt} attempts` : ''}`,
            res.status,
          );
          return delivery;
        }
        lastError = `HTTP ${res.status}`;
        // A 4xx that is not 429 will answer the same way on every retry —
        // retrying it is five seconds of theatre, not resilience.
        if (res.status !== 429 && res.status < 500) break;
      } catch (err) {
        lastError = (err as Error).message;
      }
      if (attempt < budget) {
        await this.sleep(this.backoffMs[attempt - 1] ?? this.backoffMs[this.backoffMs.length - 1]!);
      }
    }
    const delivery: NotificationDelivery = {
      lastAttemptAt: attemptedAt,
      lastResult: 'failed',
      lastError: `${lastError} — ${attempts} attempt${attempts === 1 ? '' : 's'}`,
      ...(httpCode !== undefined ? { httpCode } : {}),
    };
    this.store.recordDelivery(endpoint.id, delivery);
    this.audit('notification-failed', event, endpoint, `${tag}${delivery.lastError}`, httpCode);
    return delivery;
  }

  /** The operator-pushed test: a synthetic 'test' event down the same render
   *  and delivery path as a real transition, so a green result means the
   *  path — URL, template, signature — actually works. Single attempt: the
   *  caller is a human waiting on an answer, not a storm to ride out. */
  async testEndpoint(endpoint: NotificationEndpoint): Promise<NotificationTestResult> {
    const started = this.nowMs();
    const event: NotificationEvent = {
      id: `evt-${started.toString(36)}${randomBytes(3).toString('hex')}`,
      kind: 'test',
      at: new Date(started).toISOString(),
      fingerprint: 'test|notification|path',
      plane: 'PORTAL',
      device: '—',
      title: `Test notification for '${endpoint.name}'`,
      sev: 'P3',
      state: 'open',
      siteName: '—',
      age: '0m',
      count: 1,
      detail: 'An operator pressed Test on the Systems screen. No alert fired; this proves the endpoint, template and signature path.',
    };
    // Single attempt, honestly reported — see the doc comment.
    const delivery = await this.deliver(endpoint, event, true, 1);
    const ms = this.nowMs() - started;
    if (delivery.lastResult === 'demo') {
      return {
        ok: true,
        demo: true,
        ms,
        message: 'Demo mode — nothing was sent. The would-have-sent payload is in the outbox below.',
      };
    }
    if (delivery.lastResult === 'delivered') {
      return { ok: true, ms, httpCode: delivery.httpCode, message: `Delivered — HTTP ${delivery.httpCode}.` };
    }
    return {
      ok: false,
      ms,
      ...(delivery.httpCode !== undefined ? { httpCode: delivery.httpCode } : {}),
      message: delivery.lastError ?? 'delivery failed',
    };
  }

  private eventFor(
    kind: NotificationEvent['kind'],
    group: AlertGroup,
    previousCount: number | undefined,
    now: number,
  ): NotificationEvent {
    return {
      id: `evt-${now.toString(36)}${randomBytes(3).toString('hex')}`,
      kind,
      at: new Date(now).toISOString(),
      fingerprint: group.fingerprint,
      plane: group.latest.plane,
      device: group.latest.device,
      title: group.latest.title,
      sev: group.latest.sev,
      state: group.latest.state,
      siteName: group.latest.siteName,
      age: group.latest.age,
      count: group.count,
      ...(previousCount !== undefined ? { previousCount } : {}),
      ...(group.latest.detail ? { detail: group.latest.detail } : {}),
    };
  }

  private pushOutbox(entry: NotificationOutboxEntry): void {
    this.outboxEntries = [entry, ...this.outboxEntries].slice(0, this.outboxCapacity);
  }

  /** One audit-log line per send/failure/demo. Never a payload body — the
   *  change log's rule is "what happened, never what was in it", and a
   *  rendered Slack body can carry alert detail. */
  private audit(
    event: string,
    evt: NotificationEvent,
    endpoint: NotificationEndpoint,
    result: string,
    httpCode?: number,
  ): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event,
      changeId: evt.id,
      // A notification is not a brokered write — nothing is pushed to a
      // plane — so no ticket authorises it, exactly like a silence.
      ticket: '—',
      kind: 'notification',
      result: `${endpoint.name}: ${result}`,
      ...(httpCode !== undefined ? { httpCode } : {}),
      ...(evt.device && evt.device !== '—' ? { device: evt.device } : {}),
      plane: evt.plane,
    });
  }
}

/** The notifier's memory of one sample: every group (active or benched) plus
 *  which were benched — a silenced group still EXISTS, it is just quiet. */
function stateOf(current: { active: readonly AlertGroup[]; silenced: readonly AlertGroup[] }): NotificationSampleState {
  const groups = new Map<string, AlertGroup>();
  for (const g of current.active) groups.set(g.fingerprint, g);
  for (const g of current.silenced) groups.set(g.fingerprint, g);
  return { groups, silenced: new Set(current.silenced.map((g) => g.fingerprint)) };
}

export const notifier = new Notifier();
