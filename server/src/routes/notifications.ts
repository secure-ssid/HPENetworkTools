/**
 * server/src/routes/notifications.ts — outbound alert-notification endpoints.
 *
 *   GET    /api/notifications/endpoints          every endpoint, secrets redacted
 *   POST   /api/notifications/endpoints          {name, url, template, hmacSecret?, enabled?} → 201
 *   PUT    /api/notifications/endpoints/:id      partial edit (hmacSecret: null clears it) → 200 | 404
 *   DELETE /api/notifications/endpoints/:id      remove → {ok, endpoint} | 404
 *   POST   /api/notifications/endpoints/:id/test one honest shot down the real path → {ok, message, ...}
 *   GET    /api/notifications/status             sampler state + per-endpoint delivery
 *   GET    /api/notifications/outbox             the demo outbox (empty in live mode, says so; optional q=)
 *   GET    /api/notifications/outbox/export      CSV of outbox summaries (no payload bodies; optional q=)
 *   GET    /api/notifications/deliveries         live attempt log (no payload bodies)
 *   GET    /api/notifications/deliveries/export  CSV of delivery outcomes (no payload bodies)
 *
 * The email channel (shared/expiry.ts contracts, services/reports.ts +
 * services/smtp.ts):
 *
 *   GET    /api/notifications/smtp               the SMTP relay config, password redacted
 *   PUT    /api/notifications/smtp               create/replace (password: null clears, absent keeps)
 *   DELETE /api/notifications/smtp               remove the relay config → {ok} | 404
 *   POST   /api/notifications/smtp/test          one honest test email → {ok, message, ...}
 *   GET    /api/notifications/report             schedule + outcome + demo outbox
 *   PUT    /api/notifications/report             partial schedule edit {enabled?, frequency?, hour?, recipients?}
 *   POST   /api/notifications/report/send        force a report now (the test button)
 *   GET    /api/notifications/report/preview     the report exactly as it would send now
 *   GET    /api/notifications/report/export      CSV of report outbox metadata (no email bodies; optional q=)
 *   GET    /api/notifications/ssl-hosts          the certificate watch list
 *   POST   /api/notifications/ssl-hosts          {host: 'name[:port]'} → 201
 *   DELETE /api/notifications/ssl-hosts/:id      remove → {ok} | 404
 *   POST   /api/notifications/ssl-hosts/:id/probe re-probe one host now (demo answers, never dials)
 *
 * Notifications are NOT brokered writes — nothing is pushed to a plane — so
 * there is no ticket gate; but every mutation is an operator action and is
 * audit-logged through the same append-only change log as the silences
 * (services/writeBroker.ts appendBrokerLog), and every send, failure and
 * demo swallow is logged by the notifier itself.
 *
 * Validation refuses rather than repairs, the repo's rule: a name is
 * required and capped, the URL must pass the same SSRF discipline as the
 * Central webhook callbacks (validateCallbackUrl — HTTPS, never a private
 * or loopback address), the template is one of four known kinds, and a
 * provided-but-empty secret is a 400 with the instruction to send null to
 * clear — never a silent rewrite of what the operator meant.
 */

import type { Request } from 'express';
import { Router } from 'express';
import {
  isNotificationTemplateKind,
  isReportFrequency,
  parseSslTarget,
  validateNotificationEndpoint,
  validateReportConfig,
  validateSmtpConfig,
  MAX_SSL_HOSTS,
  SMTP_DEFAULT_PORT,
  type NotificationDeliveryAttempt,
  type NotificationEndpoint,
  type NotificationEndpointForm,
  type NotificationOutboxEntry,
  type ReportConfig,
  type ReportOutboxEntry,
  type SmtpConfigForm,
  type SslProbeHost,
} from '@hpe/shared';
import { sendCsv } from '../lib/csv';
import { queryOneOf, queryString } from '../lib/query';
import { h } from './handler';
import { notifier } from '../services/notifier';
import { notificationStore, toSmtpView, toView } from '../services/notifierStore';
import { reportService } from '../services/reports';
import { appendBrokerLog, brokerDataDir } from '../services/writeBroker';

export const notificationsRouter = Router();

const DELIVERY_RESULTS = ['delivered', 'failed', 'demo'] as const;

/**
 * Optional `?result=delivered|failed|demo` and `?q=` on the live delivery log / CSV.
 * - result: queryOneOf allow-list (unknown → honest no-op)
 * - q: case-insensitive substring on endpoint / title / error / eventKind /
 *   fingerprint / result / httpCode / test flag (empty → no text filter)
 * Never invents an empty log from junk tokens.
 */
export function filterDeliveryAttempts(
  req: Request,
  entries: readonly NotificationDeliveryAttempt[],
): NotificationDeliveryAttempt[] {
  const result = queryOneOf(req, 'result', DELIVERY_RESULTS);
  const q = queryString(req, 'q').toLowerCase();
  if (!result && !q) return [...entries];
  return entries.filter((e) => {
    if (result && e.result !== result) return false;
    if (q) {
      const hay = [
        e.endpointName,
        e.title,
        e.error ?? '',
        e.eventKind,
        e.fingerprint,
        e.result,
        e.httpCode ?? '',
        e.test ? 'test' : '',
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Optional `?q=` on the SSL certificate watch list / CSV (Loop 116).
 * Case-insensitive substring on host, port, probe error, notAfter, and
 * ok/fail tokens. Empty → no text filter (honest full watch list).
 */
export function filterSslHosts(req: Request, hosts: readonly SslProbeHost[]): SslProbeHost[] {
  const q = queryString(req, 'q').toLowerCase();
  if (!q) return [...hosts];
  return hosts.filter((h) => {
    const probe = h.lastProbe;
    const hay = [
      h.host,
      String(h.port),
      probe?.error ?? '',
      probe?.notAfter ?? '',
      probe?.ok === true ? 'ok yes' : probe?.ok === false ? 'fail no error' : '',
      probe?.daysLeft ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/**
 * Optional `?q=` on the webhook demo outbox list / CSV (Loop 119).
 * Case-insensitive substring on endpoint / title / eventKind / fingerprint /
 * plane / device / site / sev / id — never scans payload bodies. Empty → full
 * outbox (honest no-op).
 */
export function filterNotificationOutbox(
  req: Request,
  entries: readonly NotificationOutboxEntry[],
): NotificationOutboxEntry[] {
  const q = queryString(req, 'q').toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => {
    const hay = [
      e.id,
      e.endpointName,
      e.contentType,
      e.event.kind,
      e.event.id,
      e.event.fingerprint,
      e.event.title,
      e.event.sev,
      e.event.plane,
      e.event.device,
      e.event.siteName,
      e.event.state,
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/**
 * Optional `?q=` on the fleet-report demo outbox CSV (Loop 119).
 * Case-insensitive substring on subject / recipients / id — never scans
 * email text/html bodies. Empty → full outbox (honest no-op).
 */
export function filterReportOutbox(
  req: Request,
  entries: readonly ReportOutboxEntry[],
): ReportOutboxEntry[] {
  const q = queryString(req, 'q').toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => {
    const hay = [e.id, e.subject, e.recipients.join(' '), e.demo ? 'demo' : '']
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

notificationsRouter.get(
  '/notifications/endpoints',
  h(async (_req, res) => {
    res.json({ endpoints: notificationStore.views() });
  }),
);

notificationsRouter.post(
  '/notifications/endpoints',
  h(async (req, res) => {
    const parsed = parseEndpointBody(req.body, true);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    const errors = validateNotificationEndpoint(parsed.form);
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join('; ') });
      return;
    }
    const endpoint = notificationStore.create({
      name: parsed.form.name.trim(),
      url: parsed.form.url.trim(),
      template: parsed.form.template,
      ...(typeof parsed.form.hmacSecret === 'string' ? { hmacSecret: parsed.form.hmacSecret } : {}),
      enabled: parsed.form.enabled,
    });
    logEndpointEvent('notification-endpoint-created', endpoint, `created '${endpoint.name}' (${endpoint.template}) → ${endpoint.url}`);
    res.status(201).json({ endpoint: toView(endpoint) });
  }),
);

notificationsRouter.put(
  '/notifications/endpoints/:id',
  h(async (req, res) => {
    const existing = notificationStore.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: `unknown notification endpoint '${req.params.id}'` });
      return;
    }
    const parsed = parseEndpointBody(req.body, false);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    // Validate the MERGED result — the rule holds on what would be stored,
    // not on whichever fields happened to be in this request.
    const merged: NotificationEndpointForm = {
      name: parsed.form.name ?? existing.name,
      url: parsed.form.url ?? existing.url,
      template: parsed.form.template ?? existing.template,
      hmacSecret:
        typeof parsed.form.hmacSecret === 'string' ? parsed.form.hmacSecret : existing.hmacSecret ?? null,
      enabled: parsed.form.enabled ?? existing.enabled,
    };
    const errors = validateNotificationEndpoint(merged);
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join('; ') });
      return;
    }
    const updated = notificationStore.update(req.params.id, {
      ...(parsed.form.name !== undefined ? { name: parsed.form.name.trim() } : {}),
      ...(parsed.form.url !== undefined ? { url: parsed.form.url.trim() } : {}),
      ...(parsed.form.template !== undefined ? { template: parsed.form.template } : {}),
      ...(parsed.form.enabled !== undefined ? { enabled: parsed.form.enabled } : {}),
      ...(parsed.form.hmacSecret !== undefined ? { hmacSecret: parsed.form.hmacSecret } : {}),
    });
    if (!updated) {
      res.status(404).json({ error: `unknown notification endpoint '${req.params.id}'` });
      return;
    }
    logEndpointEvent(
      'notification-endpoint-updated',
      updated,
      `updated '${updated.name}' (${updated.template}, ${updated.enabled ? 'enabled' : 'disabled'}) → ${updated.url}` +
        (parsed.form.hmacSecret === null
          ? ' — signing secret cleared'
          : typeof parsed.form.hmacSecret === 'string'
            ? ' — signing secret replaced'
            : ''),
    );
    res.json({ endpoint: toView(updated) });
  }),
);

notificationsRouter.delete(
  '/notifications/endpoints/:id',
  h(async (req, res) => {
    const removed = notificationStore.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: `unknown notification endpoint '${req.params.id}'` });
      return;
    }
    logEndpointEvent('notification-endpoint-deleted', removed, `deleted '${removed.name}' → ${removed.url}`);
    res.json({ ok: true, endpoint: toView(removed) });
  }),
);

notificationsRouter.post(
  '/notifications/endpoints/:id/test',
  h(async (req, res) => {
    const endpoint = notificationStore.get(req.params.id);
    if (!endpoint) {
      res.status(404).json({ error: `unknown notification endpoint '${req.params.id}'` });
      return;
    }
    // The notifier audits the outcome itself (sent / failed / demo), with
    // the same honesty rules as a real transition.
    res.json(await notifier.testEndpoint(endpoint));
  }),
);

notificationsRouter.get(
  '/notifications/status',
  h(async (_req, res) => {
    res.json(notifier.status());
  }),
);

notificationsRouter.get(
  '/notifications/outbox',
  h(async (req, res) => {
    const status = notifier.status();
    res.json({
      demoMode: status.demoMode,
      entries: filterNotificationOutbox(req, notifier.outbox()),
      // An empty outbox in live mode is not "nothing would have been sent" —
      // it is "this process made real network calls instead". Say which.
      ...(status.demoMode
        ? {}
        : { note: 'live mode — notifications are POSTed for real; the outbox only fills in demo mode' }),
    });
  }),
);

/**
 * GET /api/notifications/outbox/export — CSV of webhook demo-outbox summaries.
 * Never includes payload bodies, URLs, or HMAC secrets (Loop 101).
 * Optional `?q=` matches list triage fields only (Loop 119).
 */
notificationsRouter.get(
  '/notifications/outbox/export',
  h(async (req, res) => {
    const entries = filterNotificationOutbox(req, notifier.outbox());
    sendCsv(
      res,
      'notification-outbox.csv',
      [
        'at',
        'id',
        'endpoint',
        'contentType',
        'demo',
        'eventKind',
        'eventId',
        'fingerprint',
        'title',
        'sev',
        'plane',
        'device',
        'siteName',
        'count',
      ],
      entries.map((e) => [
        e.at,
        e.id,
        e.endpointName,
        e.contentType,
        e.demo ? 'yes' : 'no',
        e.event.kind,
        e.event.id,
        e.event.fingerprint,
        e.event.title,
        e.event.sev,
        e.event.plane,
        e.event.device,
        e.event.siteName,
        e.event.count,
      ]),
    );
  }),
);

/**
 * Live delivery attempt log — outcome metadata only (no payload bodies).
 * Complements the demo outbox: live mode fills this when POSTs happen.
 * Optional `?result=delivered|failed|demo` and `?q=` narrow the tail.
 */
notificationsRouter.get(
  '/notifications/deliveries',
  h(async (req, res) => {
    res.json({
      demoMode: notifier.status().demoMode,
      entries: filterDeliveryAttempts(req, notifier.deliveries()),
    });
  }),
);

/**
 * GET /api/notifications/deliveries/export — CSV of delivery outcomes only.
 * Never includes payload bodies, HMAC secrets, or endpoint URLs.
 * Optional `?result=` / `?q=` match the list filter.
 */
notificationsRouter.get(
  '/notifications/deliveries/export',
  h(async (req, res) => {
    const entries = filterDeliveryAttempts(req, notifier.deliveries());
    sendCsv(
      res,
      'notification-deliveries.csv',
      ['at', 'result', 'test', 'endpoint', 'title', 'httpCode', 'error', 'eventKind', 'fingerprint'],
      entries.map((e) => [
        e.at,
        e.result,
        e.test ? 'yes' : 'no',
        e.endpointName,
        e.title,
        e.httpCode ?? '',
        e.error ?? '',
        e.eventKind,
        e.fingerprint,
      ]),
    );
  }),
);

// ---------------------------------------------------------------------------
// SMTP relay configuration
// ---------------------------------------------------------------------------

notificationsRouter.get(
  '/notifications/smtp',
  h(async (_req, res) => {
    res.json({ smtp: notificationStore.smtpView() });
  }),
);

notificationsRouter.put(
  '/notifications/smtp',
  h(async (req, res) => {
    const parsed = parseSmtpBody(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    const errors = validateSmtpConfig(parsed);
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join('; ') });
      return;
    }
    const existing = notificationStore.smtp();
    const saved = notificationStore.setSmtp({
      host: parsed.host.trim(),
      port: parsed.port ?? SMTP_DEFAULT_PORT,
      ...(parsed.user !== undefined && parsed.user.trim() ? { user: parsed.user.trim() } : {}),
      ...(parsed.password !== undefined ? { password: parsed.password } : {}),
      from: parsed.from.trim(),
      tls: parsed.tls,
    });
    logEmailEvent(
      'notification-smtp-saved',
      `smtp relay ${existing ? 'updated' : 'configured'}: ${saved.host}:${saved.port} ` +
        `(${saved.tls ? 'STARTTLS' : 'plaintext'}, auth ${saved.user ? `user '${saved.user}'` : 'none'}, from ${saved.from})` +
        (parsed.password === null ? ' — password cleared' : typeof parsed.password === 'string' ? ' — password replaced' : ''),
    );
    res.json({ smtp: toSmtpView(saved) });
  }),
);

notificationsRouter.delete(
  '/notifications/smtp',
  h(async (_req, res) => {
    const removed = notificationStore.clearSmtp();
    if (!removed) {
      res.status(404).json({ error: 'SMTP is not configured' });
      return;
    }
    logEmailEvent('notification-smtp-removed', `smtp relay removed: ${removed.host}:${removed.port}`);
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/notifications/smtp/test',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.to !== undefined && (typeof body.to !== 'string' || !body.to.trim())) {
      res.status(400).json({ error: 'to must be a non-empty string when provided' });
      return;
    }
    // The service audits the outcome itself (sent / failed / demo), with the
    // same honesty rules as a real send.
    res.json(await reportService.testSmtp(typeof body.to === 'string' ? body.to.trim() : undefined));
  }),
);

// ---------------------------------------------------------------------------
// Fleet summary report
// ---------------------------------------------------------------------------

notificationsRouter.get(
  '/notifications/report',
  h(async (_req, res) => {
    const demoMode = reportService.isDemoMode();
    res.json({
      config: notificationStore.report(),
      demoMode,
      entries: reportService.outbox(),
      ...(demoMode
        ? {}
        : { note: 'live mode — reports are emailed for real; the outbox only fills in demo mode' }),
    });
  }),
);

notificationsRouter.put(
  '/notifications/report',
  h(async (req, res) => {
    const parsed = parseReportBody(req.body);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    // Validate the MERGED result — the rule holds on what would be stored,
    // not on whichever fields happened to be in this request.
    const merged = { ...notificationStore.report(), ...parsed };
    const errors = validateReportConfig({ frequency: merged.frequency, hour: merged.hour, recipients: merged.recipients });
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join('; ') });
      return;
    }
    const saved = notificationStore.setReport(parsed);
    logEmailEvent(
      'notification-report-updated',
      `fleet report ${saved.enabled ? 'enabled' : 'disabled'} — ${saved.frequency} at ${String(saved.hour).padStart(2, '0')}:00 UTC` +
        ` to ${saved.recipients.length > 0 ? saved.recipients.join(', ') : 'nobody (no recipients)'}`,
    );
    res.json({ config: saved });
  }),
);

notificationsRouter.post(
  '/notifications/report/send',
  h(async (_req, res) => {
    res.json(await reportService.sendReportNow());
  }),
);

notificationsRouter.get(
  '/notifications/report/preview',
  h(async (_req, res) => {
    res.json({ report: await reportService.buildPreview() });
  }),
);

/**
 * GET /api/notifications/report/export — CSV of fleet-report demo outbox
 * metadata only (subject/recipients/at). Never email text/html bodies
 * (Loop 101). Optional `?q=` on subject/recipients/id (Loop 119). Empty in
 * live mode when nothing was demo-rendered.
 */
notificationsRouter.get(
  '/notifications/report/export',
  h(async (req, res) => {
    const entries = filterReportOutbox(req, reportService.outbox());
    sendCsv(
      res,
      'fleet-report-outbox.csv',
      ['at', 'id', 'subject', 'recipientCount', 'recipients', 'demo'],
      entries.map((e) => [
        e.at,
        e.id,
        e.subject,
        e.recipients.length,
        e.recipients.join('; '),
        e.demo ? 'yes' : 'no',
      ]),
    );
  }),
);

// ---------------------------------------------------------------------------
// SSL certificate watch
// ---------------------------------------------------------------------------

/**
 * GET /api/notifications/ssl-hosts/export — CSV of the certificate watch list.
 * Probe outcome fields only; never private keys or full cert PEMs.
 * Optional `?q=` matches the list filter (Loop 116).
 * Registered before `/:id` so "export" is never treated as an id.
 */
notificationsRouter.get(
  '/notifications/ssl-hosts/export',
  h(async (req, res) => {
    const hosts = filterSslHosts(req, notificationStore.sslHosts());
    sendCsv(
      res,
      'ssl-hosts.csv',
      [
        'host',
        'port',
        'addedAt',
        'probeOk',
        'probedAt',
        'notAfter',
        'daysLeft',
        'error',
      ],
      hosts.map((row) => [
        row.host,
        row.port,
        row.addedAt,
        row.lastProbe ? (row.lastProbe.ok ? 'yes' : 'no') : '',
        row.lastProbe?.at ?? '',
        row.lastProbe?.notAfter ?? '',
        row.lastProbe?.daysLeft ?? '',
        row.lastProbe?.error ?? '',
      ]),
    );
  }),
);

notificationsRouter.get(
  '/notifications/ssl-hosts',
  h(async (req, res) => {
    res.json({ hosts: filterSslHosts(req, notificationStore.sslHosts()) });
  }),
);

notificationsRouter.post(
  '/notifications/ssl-hosts',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.host !== 'string') {
      res.status(400).json({ error: 'host is required and must be a string (\'name[:port]\')' });
      return;
    }
    const target = parseSslTarget(body.host);
    if (typeof target === 'string') {
      res.status(400).json({ error: target });
      return;
    }
    const existing = notificationStore.sslHosts();
    if (existing.some((x) => x.host === target.host && x.port === target.port)) {
      res.status(400).json({ error: `${target.host}:${target.port} is already on the watch list` });
      return;
    }
    if (existing.length >= MAX_SSL_HOSTS) {
      res.status(400).json({ error: `the watch list is capped at ${MAX_SSL_HOSTS} hosts` });
      return;
    }
    const host = notificationStore.addSslHost(target);
    logEmailEvent('notification-ssl-host-added', `watching ${host.host}:${host.port} certificate expiry`);
    res.status(201).json({ host });
  }),
);

notificationsRouter.delete(
  '/notifications/ssl-hosts/:id',
  h(async (req, res) => {
    const removed = notificationStore.removeSslHost(req.params.id);
    if (!removed) {
      res.status(404).json({ error: `unknown ssl host '${req.params.id}'` });
      return;
    }
    logEmailEvent('notification-ssl-host-removed', `stopped watching ${removed.host}:${removed.port}`);
    res.json({ ok: true, host: removed });
  }),
);

notificationsRouter.post(
  '/notifications/ssl-hosts/:id/probe',
  h(async (req, res) => {
    const result = await reportService.probeHostNow(req.params.id);
    if (result === null) {
      res.status(404).json({ error: `unknown ssl host '${req.params.id}'` });
      return;
    }
    res.json(result);
  }),
);

/** What the body parser hands back on update: either a 400 message or the
 *  fields it accepted, with `hmacSecret` keeping its three states distinct. */
interface ParsedEndpointPatch {
  form: {
    name?: string;
    url?: string;
    template?: NotificationEndpointForm['template'];
    hmacSecret?: string | null;
    enabled?: boolean;
  };
}

function parseEndpointBody(raw: unknown, create: true): { form: NotificationEndpointForm } | string;
function parseEndpointBody(raw: unknown, create: false): ParsedEndpointPatch | string;
/** Require-all on create, any-subset on update; the merged-form validation
 *  in the route is what actually gates the write. */
function parseEndpointBody(raw: unknown, create: boolean): { form: NotificationEndpointForm } | ParsedEndpointPatch | string {
  const body = (raw ?? {}) as Record<string, unknown>;
  const form: ParsedEndpointPatch['form'] = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return 'name must be a string';
    form.name = body.name;
  }
  if (body.url !== undefined) {
    if (typeof body.url !== 'string') return 'url must be a string';
    form.url = body.url;
  }
  if (body.template !== undefined) {
    if (!isNotificationTemplateKind(body.template)) return "template must be one of generic, slack, teams, ntfy";
    form.template = body.template;
  }
  if (body.hmacSecret !== undefined) {
    if (body.hmacSecret === null) form.hmacSecret = null;
    else if (typeof body.hmacSecret === 'string') {
      if (!body.hmacSecret) return 'hmacSecret must be non-empty when provided — send null to clear a stored secret';
      form.hmacSecret = body.hmacSecret;
    } else return 'hmacSecret must be a string or null';
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
    form.enabled = body.enabled;
  }

  if (create) {
    for (const key of ['name', 'url', 'template'] as const) {
      if (form[key] === undefined) return `${key} is required`;
    }
    // The overload promises the caller a complete form on create; the loop
    // above is what makes that promise true.
    return {
      form: {
        name: form.name as string,
        url: form.url as string,
        template: form.template as NotificationEndpointForm['template'],
        ...(form.hmacSecret !== undefined ? { hmacSecret: form.hmacSecret } : {}),
        enabled: form.enabled ?? true,
      },
    };
  }
  return { form };
}

/** One audit-log line for an endpoint create/update/delete. Never the
 *  secret — the result string names the endpoint and what changed, nothing
 *  more. */
function logEndpointEvent(event: string, endpoint: NotificationEndpoint, result: string): void {
  appendBrokerLog(brokerDataDir(), {
    ts: new Date().toISOString(),
    event,
    changeId: endpoint.id,
    // Not a brokered write: no ticket authorises it, same as a silence.
    ticket: '—',
    kind: 'notification',
    result,
  });
}

/** Parse the SMTP save body. host/from/tls are required (tls has no honest
 *  default — plaintext vs STARTTLS is a decision, not an omission); port
 *  defaults to 587, user is optional, password keeps the tri-state. */
function parseSmtpBody(raw: unknown): SmtpConfigForm | string {
  const body = (raw ?? {}) as Record<string, unknown>;
  const form: SmtpConfigForm = { host: '', from: '', tls: false };
  if (typeof body.host !== 'string') return 'host is required';
  form.host = body.host;
  if (body.port !== undefined) {
    if (typeof body.port !== 'number') return 'port must be a number';
    form.port = body.port;
  }
  if (body.user !== undefined) {
    if (typeof body.user !== 'string') return 'user must be a string';
    form.user = body.user;
  }
  if (body.password !== undefined) {
    if (body.password === null) form.password = null;
    else if (typeof body.password === 'string') {
      if (!body.password) return 'password must be non-empty when provided — send null to clear a stored password';
      form.password = body.password;
    } else return 'password must be a string or null';
  }
  if (typeof body.from !== 'string') return 'from is required';
  form.from = body.from;
  if (typeof body.tls !== 'boolean') return 'tls must be a boolean (true = STARTTLS)';
  form.tls = body.tls;
  return form;
}

/** Parse a report schedule patch — any subset of the four fields, each
 *  type-checked; the route validates the merged result. */
function parseReportBody(raw: unknown): Partial<Pick<ReportConfig, 'enabled' | 'frequency' | 'hour' | 'recipients'>> | string {
  const body = (raw ?? {}) as Record<string, unknown>;
  const patch: Partial<Pick<ReportConfig, 'enabled' | 'frequency' | 'hour' | 'recipients'>> = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
    patch.enabled = body.enabled;
  }
  if (body.frequency !== undefined) {
    if (!isReportFrequency(body.frequency)) return 'frequency must be daily or weekly';
    patch.frequency = body.frequency;
  }
  if (body.hour !== undefined) {
    if (typeof body.hour !== 'number') return 'hour must be a number (0–23, UTC)';
    patch.hour = body.hour;
  }
  if (body.recipients !== undefined) {
    if (!Array.isArray(body.recipients) || body.recipients.some((r) => typeof r !== 'string')) {
      return 'recipients must be a list of email addresses';
    }
    patch.recipients = body.recipients as string[];
  }
  return patch;
}

/** One audit-log line for an email-channel change. Never the password —
 *  the result string names the relay and what changed, nothing more. */
function logEmailEvent(event: string, result: string): void {
  appendBrokerLog(brokerDataDir(), {
    ts: new Date().toISOString(),
    event,
    changeId: `email-${Date.now().toString(36)}`,
    ticket: '—',
    kind: 'notification',
    result,
  });
}
