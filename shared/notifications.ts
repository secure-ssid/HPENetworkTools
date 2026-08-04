/**
 * shared/notifications.ts — outbound alert-notification contracts + pure logic.
 *
 * The portal's alert queue already dedupes firing storms into groups
 * (alertEngine.ts) and lets an operator hush them (silences). What it could
 * not do is tell anyone: a P1 that fires at 03:00 only reaches the people
 * watching the screen. This module is the contract half of fixing that —
 * endpoint configuration, the transition events a sampler derives from the
 * queue, and the per-template payload rendering. No I/O and no clock beyond
 * what a caller hands in, so the server notifier, the routes and the browser
 * all share exactly one definition of "fired", "resolved" and "escalated".
 *
 * The model follows the queue's own vocabulary:
 *
 *   - FIRED. A group appears in the ACTIVE queue that was not in the previous
 *     sample at all. A group that arrives already silenced does NOT fire —
 *     hushed from birth means quiet from birth.
 *   - RESOLVED. A fingerprint leaves the queue entirely (active AND silenced
 *     bench). Only reported for fingerprints that were ACTIVE at the last
 *     sample: a silenced group that clears never paged anyone, so nobody
 *     needs the all-clear either (Alertmanager's inhibition rule). A group
 *     moving onto the silenced bench is NOT resolved — it is hushed, still
 *     firing, and saying "resolved" would be the one lie this feature must
 *     never tell.
 *   - ESCALATED. A group stays active but its firing count grew — the storm
 *     is getting worse, which is the one change to an already-known problem
 *     worth a push.
 *
 * Every URL is validated through the same SSRF discipline as the Central
 * webhook callbacks (webhooks.ts validateCallbackUrl): HTTPS only, never a
 * private, loopback or reserved address. A notification endpoint is an
 * outbound call the server makes on the operator's behalf, which is exactly
 * the SSRF shape that guard exists for.
 */

import type { AlertFingerprint, AlertGroup } from './alertEngine';
import { validateCallbackUrl } from './webhooks';

// ---------------------------------------------------------------------------
// Endpoint configuration
// ---------------------------------------------------------------------------

export type NotificationTemplateKind = 'generic' | 'slack' | 'teams' | 'ntfy';

export const NOTIFICATION_TEMPLATE_KINDS: readonly NotificationTemplateKind[] = [
  'generic',
  'slack',
  'teams',
  'ntfy',
];

export function isNotificationTemplateKind(value: unknown): value is NotificationTemplateKind {
  return typeof value === 'string' && (NOTIFICATION_TEMPLATE_KINDS as readonly string[]).includes(value);
}

/** Same bounds the Central webhook form enforces — one vocabulary for names
 *  and secrets across both outbound integrations. */
export const MAX_NOTIFICATION_NAME_CHARS = 64;
export const MAX_NOTIFICATION_SECRET_CHARS = 512;

/** The header carrying the HMAC-SHA256 signature of the raw request body
 *  when an endpoint has a secret: `sha256=<hex>` (GitHub's scheme, so any
 *  receiver framework already has an example to copy). */
export const NOTIFICATION_SIGNATURE_HEADER = 'x-hpe-signature-256';

/** One delivery attempt's outcome, persisted on the endpoint row so a
 *  restart does not erase the fact that the last send failed. */
export interface NotificationDelivery {
  lastAttemptAt: string; // ISO
  lastResult: 'delivered' | 'failed' | 'demo';
  /** Present on failure — the HTTP status or transport error, verbatim. A
   *  swallowed failure is an endpoint that looks healthy and is not. */
  lastError?: string;
  httpCode?: number;
}

/** A notification endpoint as persisted in data/notifications.json. */
export interface NotificationEndpoint {
  id: string;
  name: string;
  url: string;
  template: NotificationTemplateKind;
  /** Write-only: never served back by the API, never audit-logged. */
  hmacSecret?: string;
  enabled: boolean;
  createdAt: string; // ISO
  delivery?: NotificationDelivery;
}

/** The API view of an endpoint — the secret replaced by a configured flag. */
export interface NotificationEndpointView extends Omit<NotificationEndpoint, 'hmacSecret'> {
  hmacSecretConfigured: boolean;
}

/** What a create/update sends. `hmacSecret` semantics on update: absent
 *  keeps the stored secret, null clears it, a string replaces it. */
export interface NotificationEndpointForm {
  name: string;
  url: string;
  template: NotificationTemplateKind;
  hmacSecret?: string | null;
  enabled: boolean;
}

/** Field-level errors, refusing rather than repairing (the repo's rule).
 *  Empty = valid. */
export function validateNotificationEndpoint(form: NotificationEndpointForm): string[] {
  const errors: string[] = [];
  const name = form.name?.trim() ?? '';
  if (!name) errors.push('name is required');
  else if (name.length > MAX_NOTIFICATION_NAME_CHARS) {
    errors.push(`name must be ${MAX_NOTIFICATION_NAME_CHARS} characters or fewer`);
  }
  const urlCheck = validateCallbackUrl(form.url ?? '');
  if (!urlCheck.ok) errors.push(urlCheck.reason ?? 'endpoint URL is invalid');
  if (!isNotificationTemplateKind(form.template)) {
    errors.push(`template must be one of ${NOTIFICATION_TEMPLATE_KINDS.join(', ')}`);
  }
  if (typeof form.hmacSecret === 'string' && form.hmacSecret.length > MAX_NOTIFICATION_SECRET_CHARS) {
    errors.push(`hmacSecret must be ${MAX_NOTIFICATION_SECRET_CHARS} characters or fewer`);
  }
  return errors;
}

export const NOTIFICATION_TEMPLATE_OPTIONS: { value: NotificationTemplateKind; label: string }[] = [
  { value: 'generic', label: 'Generic JSON webhook' },
  { value: 'slack', label: 'Slack' },
  { value: 'teams', label: 'Microsoft Teams' },
  { value: 'ntfy', label: 'ntfy' },
];

// ---------------------------------------------------------------------------
// Transition events
// ---------------------------------------------------------------------------

export type AlertTransitionKind = 'fired' | 'resolved' | 'escalated';

/** 'test' is the operator-pushed test send — it travels the same render and
 *  delivery path as a real transition so a green test means a green path. */
export type NotificationEventKind = AlertTransitionKind | 'test';

/** One group-level change between two samples of the queue. */
export interface AlertGroupTransition {
  kind: AlertTransitionKind;
  fingerprint: AlertFingerprint;
  /** The group as of the CURRENT sample for fired/escalated; the last-seen
   *  snapshot for resolved (it has left the queue by definition). */
  group: AlertGroup;
  /** Escalated only: the firing count at the previous sample. */
  previousCount?: number;
}

/** The outbound event: one transition flattened into template-ready fields. */
export interface NotificationEvent {
  id: string;
  kind: NotificationEventKind;
  at: string; // ISO
  fingerprint: AlertFingerprint;
  plane: string;
  device: string;
  title: string;
  sev: string;
  state: string;
  siteName: string;
  age: string;
  count: number;
  previousCount?: number;
  detail?: string;
}

/** The notifier's memory of the last sample: every group it saw (active AND
 *  silenced — a silenced group still EXISTS, it is just quiet) plus which of
 *  them were on the bench. */
export interface NotificationSampleState {
  groups: ReadonlyMap<AlertFingerprint, AlertGroup>;
  silenced: ReadonlySet<AlertFingerprint>;
}

/**
 * Diff two samples of the alert queue into transition events. See the file
 * header for the three rules; the fourth is what is NOT here: there is no
 * event for a group moving between the active queue and the silenced bench,
 * because suppression is a presentation fact the screen already shows, not
 * an estate change worth paging about.
 */
export function diffAlertGroups(
  previous: NotificationSampleState,
  current: { active: readonly AlertGroup[]; silenced: readonly AlertGroup[] },
): AlertGroupTransition[] {
  const out: AlertGroupTransition[] = [];
  const currentFingerprints = new Set<AlertFingerprint>();
  for (const group of current.active) {
    currentFingerprints.add(group.fingerprint);
    const before = previous.groups.get(group.fingerprint);
    if (!before) {
      out.push({ kind: 'fired', fingerprint: group.fingerprint, group });
    } else if (group.count > before.count) {
      out.push({ kind: 'escalated', fingerprint: group.fingerprint, group, previousCount: before.count });
    }
  }
  for (const group of current.silenced) currentFingerprints.add(group.fingerprint);
  for (const [fingerprint, group] of previous.groups) {
    if (currentFingerprints.has(fingerprint)) continue;
    if (previous.silenced.has(fingerprint)) continue; // quiet from birth stays quiet to the end
    out.push({ kind: 'resolved', fingerprint, group });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload rendering
// ---------------------------------------------------------------------------

export const NOTIFICATION_KIND_LABEL: Record<NotificationEventKind, string> = {
  fired: 'FIRED',
  resolved: 'RESOLVED',
  escalated: 'ESCALATED',
  test: 'TEST',
};

/** The one-line summary every template carries somewhere, so a phone lock
 *  screen is enough to decide whether to get up. */
export function notificationSummaryLine(event: NotificationEvent): string {
  const kind = NOTIFICATION_KIND_LABEL[event.kind];
  const count =
    event.kind === 'escalated' && event.previousCount !== undefined
      ? ` ×${event.count} (was ${event.previousCount})`
      : event.count > 1
        ? ` ×${event.count}`
        : '';
  return `[${event.sev}] ${kind}: ${event.title} — ${event.device} (${event.plane} · ${event.siteName})${count}`;
}

export interface RenderedNotification {
  contentType: string;
  body: string;
}

/**
 * Render an event for one template. Pure formatting — the transport
 * (HMAC header, retry, SSRF guard) lives in the server notifier.
 *
 *   generic — the full event object, verbatim. No invented structure: a
 *             receiver that wants everything gets exactly what happened.
 *   slack   — incoming-webhook shape { text }.
 *   teams   — legacy MessageCard, the shape every Teams incoming webhook
 *             still accepts; the theme color carries the transition kind.
 *   ntfy    — plain-text body POSTed to the topic URL the operator
 *             configured, exactly what `curl -d` sends.
 */
export function renderNotification(
  template: NotificationTemplateKind,
  event: NotificationEvent,
): RenderedNotification {
  const text = notificationSummaryLine(event);
  switch (template) {
    case 'generic':
      return { contentType: 'application/json', body: JSON.stringify(event) };
    case 'slack':
      return { contentType: 'application/json', body: JSON.stringify({ text }) };
    case 'teams':
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          '@type': 'MessageCard',
          '@context': 'https://schema.org/extensions',
          summary: text,
          themeColor:
            event.kind === 'fired' ? 'D22630' : event.kind === 'escalated' ? 'B45309' : '01A783',
          title: `HPE Network Tools — ${NOTIFICATION_KIND_LABEL[event.kind]}`,
          text: event.detail ? `${text}\n\n${event.detail}` : text,
        }),
      };
    case 'ntfy': {
      const lines = [text];
      if (event.detail) lines.push('', event.detail);
      return { contentType: 'text/plain; charset=utf-8', body: lines.join('\n') };
    }
  }
}

// ---------------------------------------------------------------------------
// Demo outbox + service status (the API shapes)
// ---------------------------------------------------------------------------

/** In demo mode nothing leaves the process: the would-have-sent payload
 *  lands here instead, labelled, so the feature is fully exercisable without
 *  a single network call. */
export interface NotificationOutboxEntry {
  id: string;
  at: string; // ISO
  endpointId: string;
  endpointName: string;
  event: NotificationEvent;
  contentType: string;
  body: string;
  demo: true;
}

/** GET /api/notifications/status — the sampler's own honesty panel: is it
 *  running, when did it last look, how much of the queue is it tracking. */
export interface NotificationServiceStatus {
  demoMode: boolean;
  sampling: {
    running: boolean;
    lastSampleAt: string | null;
    trackedGroups: number;
  };
  endpoints: { id: string; delivery: NotificationDelivery | null }[];
}

/**
 * One live delivery attempt (demo or real). Bodies never appear here — only
 * outcome metadata for operator debug. Served by GET /api/notifications/deliveries.
 */
export interface NotificationDeliveryAttempt {
  id: string;
  at: string; // ISO
  endpointId: string;
  endpointName: string;
  eventKind: NotificationEvent['kind'];
  eventId: string;
  fingerprint: string;
  title: string;
  result: NotificationDelivery['lastResult'];
  httpCode?: number;
  error?: string;
  /** True when this was the operator Test button path. */
  test?: boolean;
}
