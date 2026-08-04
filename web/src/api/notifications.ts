/** Outbound alert notifications — webhook endpoints the portal POSTs alert
 *  queue transitions (fired / resolved / escalated) to. */

import { apiFetch } from './core';
import type {
  FleetReport,
  NotificationDeliveryAttempt,
  NotificationEndpointView,
  NotificationOutboxEntry,
  NotificationServiceStatus,
  NotificationTemplateKind,
  ReportConfig,
  ReportFrequency,
  ReportOutboxEntry,
  ReportSendResult,
  SmtpConfigView,
  SslProbeHost,
} from '@hpe/shared';

/** What an endpoint create/edit sends. `hmacSecret` on edit: absent keeps
 *  the stored secret, null clears it, a string replaces it. */
export interface NotificationEndpointInput {
  name: string;
  url: string;
  template: NotificationTemplateKind;
  hmacSecret?: string | null;
  enabled?: boolean;
}

/** The test-send answer, verbatim from the server. */
export interface NotificationTestResult {
  ok: boolean;
  message: string;
  demo?: boolean;
  httpCode?: number;
  ms: number;
}

export interface NotificationOutbox {
  demoMode: boolean;
  entries: NotificationOutboxEntry[];
  note?: string;
}

type Err = { error: string; offline?: boolean };

async function call<T>(path: string, init: RequestInit | undefined, pick: (body: never) => T | undefined): Promise<T | Err> {
  try {
    const r = await apiFetch(path, init);
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    if (r.ok) {
      const picked = pick(body as never);
      if (picked !== undefined) return picked;
    }
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

const json = (method: string, payload?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: payload === undefined ? undefined : JSON.stringify(payload),
});

/** GET /api/notifications/endpoints — every endpoint, secrets redacted. */
export async function getNotificationEndpoints(): Promise<{ endpoints: NotificationEndpointView[] } | Err> {
  return call('/api/notifications/endpoints', undefined, (b: { endpoints?: NotificationEndpointView[] }) =>
    b.endpoints ? { endpoints: b.endpoints } : undefined,
  );
}

/** POST /api/notifications/endpoints — create (audit-logged server-side). */
export async function createNotificationEndpoint(
  input: NotificationEndpointInput,
): Promise<{ endpoint: NotificationEndpointView } | Err> {
  return call('/api/notifications/endpoints', json('POST', input), (b: { endpoint?: NotificationEndpointView }) =>
    b.endpoint ? { endpoint: b.endpoint } : undefined,
  );
}

/** PUT /api/notifications/endpoints/:id — partial edit (audit-logged). */
export async function updateNotificationEndpoint(
  id: string,
  input: Partial<NotificationEndpointInput>,
): Promise<{ endpoint: NotificationEndpointView } | Err> {
  return call(
    `/api/notifications/endpoints/${encodeURIComponent(id)}`,
    json('PUT', input),
    (b: { endpoint?: NotificationEndpointView }) => (b.endpoint ? { endpoint: b.endpoint } : undefined),
  );
}

/** DELETE /api/notifications/endpoints/:id — remove (audit-logged). */
export async function deleteNotificationEndpoint(id: string): Promise<{ ok: true } | Err> {
  return call(`/api/notifications/endpoints/${encodeURIComponent(id)}`, json('DELETE'), (b: { ok?: boolean }) =>
    b.ok ? { ok: true } : undefined,
  );
}

/** POST /api/notifications/endpoints/:id/test — one honest shot down the
 *  real render/sign/POST path; the message is the server's own wording. */
export async function testNotificationEndpoint(id: string): Promise<{ result: NotificationTestResult } | Err> {
  return call(
    `/api/notifications/endpoints/${encodeURIComponent(id)}/test`,
    json('POST'),
    (b: NotificationTestResult & { message?: string }) =>
      typeof b.message === 'string' ? { result: b } : undefined,
  );
}

/** GET /api/notifications/status — sampler state + per-endpoint delivery. */
export async function getNotificationStatus(): Promise<{ status: NotificationServiceStatus } | Err> {
  return call('/api/notifications/status', undefined, (b: NotificationServiceStatus & { sampling?: unknown }) =>
    b.sampling ? { status: b } : undefined,
  );
}

/** GET /api/notifications/outbox — the demo outbox (live mode answers empty
 *  with a note saying why). */
export async function getNotificationOutbox(): Promise<{ outbox: NotificationOutbox } | Err> {
  return call('/api/notifications/outbox', undefined, (b: NotificationOutbox & { entries?: unknown }) =>
    Array.isArray(b.entries) ? { outbox: b } : undefined,
  );
}

export interface NotificationDeliveries {
  demoMode: boolean;
  entries: NotificationDeliveryAttempt[];
}

/** GET /api/notifications/deliveries — live attempt log (no payload bodies). */
export async function getNotificationDeliveries(): Promise<{ deliveries: NotificationDeliveries } | Err> {
  return call(
    '/api/notifications/deliveries',
    undefined,
    (b: { demoMode?: boolean; entries?: unknown }) =>
      typeof b.demoMode === 'boolean' && Array.isArray(b.entries)
        ? { deliveries: { demoMode: b.demoMode, entries: b.entries as NotificationDeliveryAttempt[] } }
        : undefined,
  );
}

// ---------------------------------------------------------------------------
// Email channel — SMTP relay, fleet summary report, SSL certificate watch
// ---------------------------------------------------------------------------

/** What an SMTP save sends. `password` semantics: absent keeps the stored
 *  one, null clears it, a string replaces it. */
export interface SmtpConfigInput {
  host: string;
  port?: number;
  user?: string;
  password?: string | null;
  from: string;
  tls: boolean;
}

export interface ReportSchedule {
  config: ReportConfig;
  demoMode: boolean;
  entries: ReportOutboxEntry[];
  note?: string;
}

/** GET /api/notifications/smtp — the relay config, password redacted. */
export async function getSmtpConfig(): Promise<{ smtp: SmtpConfigView | null } | Err> {
  return call('/api/notifications/smtp', undefined, (b: { smtp?: SmtpConfigView | null }) =>
    b.smtp !== undefined ? { smtp: b.smtp } : undefined,
  );
}

/** PUT /api/notifications/smtp — create or replace (audit-logged). */
export async function putSmtpConfig(input: SmtpConfigInput): Promise<{ smtp: SmtpConfigView } | Err> {
  return call('/api/notifications/smtp', json('PUT', input), (b: { smtp?: SmtpConfigView }) =>
    b.smtp ? { smtp: b.smtp } : undefined,
  );
}

/** DELETE /api/notifications/smtp — remove the relay config. */
export async function deleteSmtpConfig(): Promise<{ ok: true } | Err> {
  return call('/api/notifications/smtp', json('DELETE'), (b: { ok?: boolean }) => (b.ok ? { ok: true } : undefined));
}

/** POST /api/notifications/smtp/test — one honest test email down the real
 *  path; the message is the server's own wording. */
export async function testSmtpConfig(to?: string): Promise<{ result: ReportSendResult } | Err> {
  return call('/api/notifications/smtp/test', json('POST', to ? { to } : {}), (b: ReportSendResult & { message?: string }) =>
    typeof b.message === 'string' ? { result: b } : undefined,
  );
}

/** GET /api/notifications/report — schedule, last outcome, demo outbox. */
export async function getReportSchedule(): Promise<{ report: ReportSchedule } | Err> {
  return call('/api/notifications/report', undefined, (b: ReportSchedule & { config?: unknown }) =>
    b.config ? { report: b } : undefined,
  );
}

/** PUT /api/notifications/report — partial schedule edit (audit-logged). */
export async function putReportSchedule(patch: {
  enabled?: boolean;
  frequency?: ReportFrequency;
  hour?: number;
  recipients?: string[];
}): Promise<{ config: ReportConfig } | Err> {
  return call('/api/notifications/report', json('PUT', patch), (b: { config?: ReportConfig }) =>
    b.config ? { config: b.config } : undefined,
  );
}

/** POST /api/notifications/report/send — force a report now; the result says
 *  honestly what happened (sent / demo / skipped / failed). */
export async function sendReportNow(): Promise<{ result: ReportSendResult } | Err> {
  return call('/api/notifications/report/send', json('POST'), (b: ReportSendResult & { message?: string }) =>
    typeof b.message === 'string' ? { result: b } : undefined,
  );
}

/** GET /api/notifications/report/preview — the report exactly as it would
 *  send right now, whatever the mode. */
export async function getReportPreview(): Promise<{ report: FleetReport } | Err> {
  return call('/api/notifications/report/preview', undefined, (b: { report?: FleetReport }) =>
    b.report ? { report: b.report } : undefined,
  );
}

/** GET /api/notifications/ssl-hosts — the certificate watch list. */
export async function getSslHosts(): Promise<{ hosts: SslProbeHost[] } | Err> {
  return call('/api/notifications/ssl-hosts', undefined, (b: { hosts?: SslProbeHost[] }) =>
    Array.isArray(b.hosts) ? { hosts: b.hosts } : undefined,
  );
}

/** POST /api/notifications/ssl-hosts — add 'host[:port]' (audit-logged). */
export async function addSslHost(host: string): Promise<{ host: SslProbeHost } | Err> {
  return call('/api/notifications/ssl-hosts', json('POST', { host }), (b: { host?: SslProbeHost }) =>
    b.host ? { host: b.host } : undefined,
  );
}

/** DELETE /api/notifications/ssl-hosts/:id — remove from the watch list. */
export async function removeSslHost(id: string): Promise<{ ok: true } | Err> {
  return call(`/api/notifications/ssl-hosts/${encodeURIComponent(id)}`, json('DELETE'), (b: { ok?: boolean }) =>
    b.ok ? { ok: true } : undefined,
  );
}

/** POST /api/notifications/ssl-hosts/:id/probe — re-probe one host now. In
 *  demo mode the server answers {demo, message} instead of dialling. */
export async function probeSslHost(id: string): Promise<{ result: { host?: SslProbeHost; demo?: boolean; message?: string } } | Err> {
  return call(
    `/api/notifications/ssl-hosts/${encodeURIComponent(id)}/probe`,
    json('POST'),
    (b: { host?: SslProbeHost; demo?: boolean; message?: string }) => (b.host || b.demo ? { result: b } : undefined),
  );
}
