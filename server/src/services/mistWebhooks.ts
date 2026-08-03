/**
 * server/src/services/mistWebhooks.ts — Mist webhook subscription management:
 * the receiver's AUTO-REGISTRATION.
 *
 * A Mist org webhook subscription is what makes the inbound receiver
 * (services/webhookReceiver.ts, POST /api/hooks/mist) actually receive: it
 * tells the Mist org to POST signed events to this portal. Creating or
 * updating one is a CONFIG CHANGE TO THE ORG. Lab mode applies directly;
 * hardened mode requires explicit review confirmation. Every landed write
 * records ONE secret-free audit line, and the
 * subscription's signing secret is write-only — sent on the write, stored
 * in the receiver's secret store so deliveries verify, and never logged,
 * echoed, or displayed.
 *
 * The three operations the UI words as register / rotate / verify are:
 *   register — POST /orgs/{org}/webhooks when no subscription carries the
 *              receiver URL, PUT …/webhooks/{id} when one does (an upsert —
 *              never a blind second subscription for the same URL);
 *   rotate   — the same upsert carrying a NEW secret: the subscription is
 *              updated first, and only then is the receiver's secret store
 *              re-armed, so the portal never verifies against a secret Mist
 *              does not have;
 *   verify   — after a write, the subscription list is re-read and the
 *              result says `verified` only when the re-read confirms it; a
 *              write that answered OK but would not re-read is reported
 *              unverified, never claimed.
 *
 * Demo mode answers the authored status and a canned, demo-labelled result —
 * nothing is written and nothing is audited, because nothing changed.
 */

import { randomBytes } from 'node:crypto';
import {
  MIST_WEBHOOK_TOPICS,
  isMistWebhookTopic,
  mistWebhookRegistrationDemoStatus,
  validateCallbackUrl,
  type MistWebhookRegistrationForm,
  type MistWebhookRegistrationResult,
  type MistWebhookRegistrationStatus,
  type MistWebhookSubscription,
} from '@hpe/shared';
import { registry as defaultRegistry, type PlaneRegistry } from '../planes/registry';
import { settings } from '../config/settings';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { evaluateWriteAdmission, type AdmitWrite } from './writeAdmission';
import {
  WEBHOOK_SECRET_MAX_CHARS,
  WEBHOOK_SECRET_MIN_CHARS,
  webhookReceiver as defaultReceiver,
  type WebhookReceiver,
} from './webhookReceiver';

/** The path half of the URL a subscription must point at — the receiver's
 *  own mounted path. A subscription pointing anywhere else never delivers
 *  here, so registration refuses it rather than recording a dead webhook. */
export const MIST_RECEIVER_PATH = '/api/hooks/mist';

/** The subscription's display name on the Mist side. */
const SUBSCRIPTION_NAME = 'hpe-network-tools receiver';

/** The MistAdapter surface this service needs — structural, not
 *  `instanceof`, so tests inject a plain stub the way writeBroker.ts's
 *  BrokerTransport does. */
export interface MistWebhookPlane {
  listMistWebhooks(): Promise<MistWebhookSubscription[] | null>;
  writeMistWebhook(
    existingId: string | null,
    form: { url: string; name: string; topics: string[]; enabled: true; secret?: string },
  ): Promise<{ httpCode: number; ok: boolean; subscription: MistWebhookSubscription | null }>;
}

export interface MistWebhooksOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  receiver?: WebhookReceiver; // default: the process-wide singleton
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  demoMode?: () => boolean; // default: settings.demoMode
  nowMs?: () => number;
  /** Test override — undefined resolves the MistAdapter from the registry. */
  plane?: MistWebhookPlane | null;
  /** Test seam. Production always evaluates canonical settings + registry. */
  admitWrite?: AdmitWrite;
}

/** True when the URL's path ends with the receiver path (query and trailing
 *  slashes ignored) — "this subscription delivers to THIS receiver". */
function urlOnReceiverPath(url: string): boolean {
  const path = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return path.endsWith(MIST_RECEIVER_PATH);
}

/** The subscription rows whose URL targets this receiver (usually 0 or 1). */
function receiverSubscriptions(list: MistWebhookSubscription[]): MistWebhookSubscription[] {
  return list.filter((s) => s.url !== null && urlOnReceiverPath(s.url));
}

function resolvePlane(reg: PlaneRegistry): { plane: MistWebhookPlane | null; linked: boolean } {
  const adapter = reg.get('mist');
  const candidate = adapter as unknown as Partial<MistWebhookPlane>;
  const plane =
    typeof candidate.listMistWebhooks === 'function' && typeof candidate.writeMistWebhook === 'function'
      ? (candidate as MistWebhookPlane)
      : null;
  return { plane, linked: adapter.state().linked };
}

function planeFor(opts: MistWebhooksOptions): { plane: MistWebhookPlane | null; linked: boolean } {
  if (opts.plane !== undefined) return { plane: opts.plane, linked: opts.plane !== null };
  return resolvePlane(opts.registry ?? defaultRegistry);
}

function sameTopicSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('') === [...b].sort().join('');
}

/**
 * The receiver-registration status for the Systems Mist drawer: which of the
 * org's subscriptions point at this receiver, and when a delivery last
 * arrived. Demo mode serves the authored fixture with the receiver's real
 * last-received stamp riding along. Live mode reads the subscription list
 * fresh every call (the drawer's "verify" is exactly this re-read) — a list
 * that cannot be read is an honest error, never an empty "nothing
 * registered" claim.
 */
export async function mistWebhookRegistrationStatus(
  opts: MistWebhooksOptions = {},
): Promise<MistWebhookRegistrationStatus> {
  const demoMode = (opts.demoMode ?? (() => settings.get().demoMode))();
  const receiver = opts.receiver ?? defaultReceiver;
  const lastReceivedAt = receiver.status().find((s) => s.source === 'mist')?.lastReceivedAt ?? null;
  if (demoMode) return mistWebhookRegistrationDemoStatus(demoMode, lastReceivedAt);

  const { plane, linked } = planeFor(opts);
  const admission =
    opts.admitWrite?.({ operation: 'mist-webhook', plane: 'mist' }) ??
    (opts.plane !== undefined
      ? opts.plane !== null
        ? { ok: true as const, plane: 'mist' as const, adapter: {} as never }
        : {
            ok: false as const,
            status: 409 as const,
            code: 'unlinked' as const,
            plane: 'mist' as const,
            message: 'Mist is not linked',
          }
      : evaluateWriteAdmission(
          { operation: 'mist-webhook', plane: 'mist' },
          { registry: opts.registry ?? defaultRegistry },
        ));
  const canWrite = linked && plane !== null && admission.ok;
  if (!linked) {
    return {
      demoMode,
      canWrite,
      linked: false,
      receiverPath: MIST_RECEIVER_PATH,
      subscriptions: [],
      totalSubscriptions: null,
      lastReceivedAt,
      error: 'Mist is not linked — save its credentials on Connected systems before the receiver can be registered',
    };
  }
  if (plane === null) {
    return {
      demoMode,
      canWrite,
      linked,
      receiverPath: MIST_RECEIVER_PATH,
      subscriptions: [],
      totalSubscriptions: null,
      lastReceivedAt,
      error: 'the linked Mist adapter cannot manage webhook subscriptions',
    };
  }
  const list = await plane.listMistWebhooks();
  if (list === null) {
    return {
      demoMode,
      canWrite,
      linked,
      receiverPath: MIST_RECEIVER_PATH,
      subscriptions: [],
      totalSubscriptions: null,
      lastReceivedAt,
      error: 'could not read the org’s webhook subscriptions — registration state is unknown, not absent',
    };
  }
  return {
    demoMode,
    canWrite,
    linked,
    receiverPath: MIST_RECEIVER_PATH,
    subscriptions: receiverSubscriptions(list),
    totalSubscriptions: list.length,
    lastReceivedAt,
    ...(list.length === 0 ? { note: 'the org has no webhook subscriptions yet' } : {}),
  };
}

/**
 * Register/rotate is lab-direct or review-confirmed by the route. This
 * service enforces everything else: the URL must be
 * a valid HTTPS callback on the receiver path, the topics must be ones the
 * receiver normalizes, and the existing subscription list must be readable
 * before any write (a blind POST could duplicate a subscription the list
 * simply failed to show). Idempotent: a subscription already pointing at the
 * URL with the same topics and no secret rotation is 'unchanged', no write.
 */
export async function registerMistWebhook(
  form: MistWebhookRegistrationForm,
  opts: MistWebhooksOptions = {},
): Promise<MistWebhookRegistrationResult> {
  const demoMode = (opts.demoMode ?? (() => settings.get().demoMode))();
  const nowMs = opts.nowMs ?? (() => Date.now());
  const dataDir = opts.dataDir ?? process.env.HPE_DATA_DIR ?? brokerDataDir();
  const receiver = opts.receiver ?? defaultReceiver;

  // -- validation: every refusal runs before ANY call, demo included ---------
  const url = (form.url ?? '').trim();
  const check = validateCallbackUrl(url);
  if (!check.ok) {
    return { ok: false, action: 'failed', message: check.reason ?? 'the receiver URL is invalid' };
  }
  if (!urlOnReceiverPath(url)) {
    return {
      ok: false,
      action: 'failed',
      message: `the receiver URL’s path must end with ${MIST_RECEIVER_PATH} — a subscription pointing elsewhere would never deliver to this portal`,
    };
  }
  const topics = form.topics ?? [];
  if (topics.length === 0 || topics.some((t) => !isMistWebhookTopic(t))) {
    return {
      ok: false,
      action: 'failed',
      message: `topics must be chosen from ${MIST_WEBHOOK_TOPICS.join(', ')} — the topics this receiver can normalize`,
    };
  }
  const secret = typeof form.secret === 'string' && form.secret.trim().length > 0 ? form.secret.trim() : undefined;
  if (
    secret !== undefined &&
    (secret.length < WEBHOOK_SECRET_MIN_CHARS || secret.length > WEBHOOK_SECRET_MAX_CHARS)
  ) {
    return {
      ok: false,
      action: 'failed',
      message: `secret must be ${WEBHOOK_SECRET_MIN_CHARS}–${WEBHOOK_SECRET_MAX_CHARS} characters — nothing was written`,
    };
  }

  // -- demo: a canned, labelled answer — nothing written, nothing audited ----
  if (demoMode) {
    return {
      ok: true,
      action: 'created',
      demo: true,
      verified: true,
      subscription: {
        id: 'wh-demo-mist-0001',
        name: SUBSCRIPTION_NAME,
        url,
        topics: [...topics],
        enabled: true,
        secretConfigured: true,
      },
      message: 'demo mode — the registration is answered as authored; no subscription was written to a plane',
    };
  }

  const admission =
    opts.admitWrite?.({ operation: 'mist-webhook', plane: 'mist' }) ??
    (opts.plane !== undefined
      ? { ok: true as const, plane: 'mist' as const, adapter: {} as never }
      : evaluateWriteAdmission(
          { operation: 'mist-webhook', plane: 'mist' },
          { registry: opts.registry ?? defaultRegistry },
        ));
  if (!admission.ok) {
    return { ok: false, action: 'failed', message: admission.message };
  }

  const { plane, linked } = planeFor(opts);
  if (!linked) {
    return { ok: false, action: 'failed', message: 'Mist is not linked — nothing was written' };
  }
  if (plane === null) {
    return {
      ok: false,
      action: 'failed',
      message: 'the linked Mist adapter cannot manage webhook subscriptions — nothing was written',
    };
  }

  const list = await plane.listMistWebhooks();
  if (list === null) {
    return {
      ok: false,
      action: 'failed',
      message: 'could not read the org’s existing webhook subscriptions — nothing was written, because a blind create could duplicate one',
    };
  }
  const existing = list.find((s) => (s.url ?? '').trim() === url) ?? null;

  // Idempotency: same URL, same topics, enabled, and no secret rotation —
  // the subscription already says what the review asked for.
  if (existing && !secret && existing.enabled === true && sameTopicSet(existing.topics, topics)) {
    return {
      ok: true,
      action: 'unchanged',
      verified: true,
      subscription: existing,
      message: 'the subscription already points at this receiver with these topics — no write needed',
    };
  }

  const write = await plane.writeMistWebhook(existing?.id ?? null, {
    url,
    name: existing?.name ?? SUBSCRIPTION_NAME,
    topics,
    enabled: true,
    ...(secret ? { secret } : {}),
  });
  if (!write.ok) {
    return {
      ok: false,
      action: 'failed',
      httpCode: write.httpCode,
      message: `Mist answered HTTP ${write.httpCode} — nothing was written`,
    };
  }

  // The receiver re-arms only AFTER the subscription carries the secret — a
  // secret stored first would verify deliveries Mist is not signing yet (or
  // reject everything once rotated ahead of the subscription).
  if (secret) receiver.setSecret('mist', secret);

  // Verify from a re-read, never from the write's own optimism.
  const relist = await plane.listMistWebhooks();
  const found = relist?.find((s) => (s.url ?? '').trim() === url) ?? null;
  const verified = found !== null && found !== undefined ? true : undefined;
  const action = existing ? 'updated' : 'created';

  // One audit line per landed write — the review-gated discipline. The
  // secret's ROLE is recorded (rotated / unchanged / not set); its value
  // never is.
  appendBrokerLog(dataDir, {
    ts: new Date(nowMs()).toISOString(),
    event: 'mist-webhook-registration',
    changeId: `mistwh-${nowMs().toString(36)}${randomBytes(3).toString('hex')}`,
    ticket: '—',
    kind: 'webhook',
    result:
      `${action} org webhook subscription for ${url} (topics: ${topics.join(', ')}; signing secret ` +
      `${secret ? 'rotated' : existing?.secretConfigured === true ? 'unchanged' : 'not set'}` +
      `${verified === true ? ' · verified by re-read' : ' · unverified — the confirming re-read did not show it'})`,
  });

  return {
    ok: true,
    action,
    ...(verified === true ? { verified: true } : {}),
    ...(found ?? write.subscription ? { subscription: (found ?? write.subscription)! } : {}),
    message:
      verified === true
        ? `subscription ${action} and confirmed by re-read — Mist will POST ${topics.join(', ')} events to this receiver`
        : `subscription ${action} (HTTP ${write.httpCode}) but the confirming re-read did not show it — check the org before assuming delivery`,
  };
}
