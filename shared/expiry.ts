/**
 * shared/expiry.ts — the email channel, the scheduled fleet summary report,
 * and the expiry ladder. Contracts + pure logic; no I/O and no clock beyond
 * what a caller hands in, so the server scheduler (services/reports.ts), the
 * SMTP transport (services/smtp.ts), the routes and the browser all share one
 * definition of each.
 *
 * Three features, one file, because they are one pipeline:
 *
 *   - SMTP CONFIG. Where email goes: host/port/user/password/from/tls. The
 *     password is write-only at every boundary — the store is the only place
 *     the cleartext exists, views carry a `passwordConfigured` flag, and the
 *     keep/clear/replace tri-state on update is the hmacSecret rule verbatim:
 *     absent keeps, null clears, a string replaces.
 *   - FLEET REPORT. A daily/weekly summary — fleet totals by device type,
 *     the offline table, alert counts from the notification center, and
 *     subscriptions approaching expiry — rendered to text + HTML here, sent
 *     by the server scheduler. The GATE is pure (reportDue): enabled, the
 *     scheduled UTC hour, Monday for weekly, and a minimum gap between
 *     fires; `force` is the operator's test button and bypasses the clock,
 *     never the honesty.
 *   - EXPIRY LADDER. Subscriptions and SSL certificates walk down the
 *     thresholds 90/60/30/15: an item whose days-left is D matches every
 *     threshold ≥ D, its band is the TIGHTEST match, and it notifies once
 *     per band. The dedup key names the EVENT — '{id}@{expiryDate}' — so a
 *     renewal (a new expiry date) is a new key and re-arms the whole ladder.
 *
 * Everything in here is deterministic: TZ=UTC tests pin every date path.
 */

// ---------------------------------------------------------------------------
// SMTP configuration
// ---------------------------------------------------------------------------

export const SMTP_DEFAULT_PORT = 587;
export const MAX_SMTP_HOST_CHARS = 255;
export const MAX_SMTP_USER_CHARS = 255;
export const MAX_SMTP_PASSWORD_CHARS = 512;
/** RFC 5321's path ceiling — the one real bound an address has. */
export const MAX_SMTP_ADDRESS_CHARS = 320;

/** The persisted SMTP configuration (data/notification-email.json). */
export interface SmtpConfig {
  host: string;
  port: number;
  /** Optional — a relay that takes anonymous submission simply omits it. */
  user?: string;
  /** Write-only: never served back by the API, never audit-logged, never in
   *  an error string. */
  password?: string;
  from: string;
  /** STARTTLS after EHLO. Off means plaintext — the operator's call for a
   *  loopback relay, stated plainly in the UI. */
  tls: boolean;
  updatedAt: string; // ISO
}

/** The API view — the password replaced by a configured flag. */
export interface SmtpConfigView extends Omit<SmtpConfig, 'password'> {
  passwordConfigured: boolean;
}

/** What a save sends. `password` tri-state: absent keeps, null clears, a
 *  string replaces. */
export interface SmtpConfigForm {
  host: string;
  port?: number;
  user?: string;
  password?: string | null;
  from: string;
  tls: boolean;
}

/** The lightest honest address check: exactly one @, something on both
 *  sides, no whitespace. Deliverability is the server's answer, not ours. */
export function isEmailAddress(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > MAX_SMTP_ADDRESS_CHARS || /\s/.test(v)) return false;
  const at = v.indexOf('@');
  return at > 0 && at === v.lastIndexOf('@') && at < v.length - 1;
}

/** Field-level errors, refusing rather than repairing. Empty = valid. */
export function validateSmtpConfig(form: SmtpConfigForm): string[] {
  const errors: string[] = [];
  const host = form.host?.trim() ?? '';
  if (!host) errors.push('host is required');
  else if (host.length > MAX_SMTP_HOST_CHARS) errors.push(`host must be ${MAX_SMTP_HOST_CHARS} characters or fewer`);
  else if (/\s/.test(host) || host.includes('/')) {
    errors.push('host must be a hostname, not a URL — no scheme, path or whitespace');
  }
  if (form.port !== undefined) {
    if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) {
      errors.push('port must be an integer between 1 and 65535');
    }
  }
  if (!isEmailAddress(form.from ?? '')) errors.push('from must be an email address');
  if (form.user !== undefined && form.user.length > MAX_SMTP_USER_CHARS) {
    errors.push(`user must be ${MAX_SMTP_USER_CHARS} characters or fewer`);
  }
  if (typeof form.password === 'string' && form.password.length > MAX_SMTP_PASSWORD_CHARS) {
    errors.push(`password must be ${MAX_SMTP_PASSWORD_CHARS} characters or fewer`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Fleet summary report — schedule, gate, content
// ---------------------------------------------------------------------------

export type ReportFrequency = 'daily' | 'weekly';
export const REPORT_FREQUENCIES: readonly ReportFrequency[] = ['daily', 'weekly'];

export function isReportFrequency(value: unknown): value is ReportFrequency {
  return value === 'daily' || value === 'weekly';
}

/** The minimum time between two fires: a tick that lands twice in its
 *  scheduled hour must not send twice, and a failed fire retries at the next
 *  scheduled window, not every tick. */
export const REPORT_MIN_GAP_MS: Record<ReportFrequency, number> = {
  daily: 20 * 3_600_000,
  weekly: 6 * 86_400_000,
};

export const MAX_REPORT_RECIPIENTS = 25;

/** The report schedule + outcome as persisted. The outcome fields ride on
 *  the row for the notifier's own reason: a failure that lives only in
 *  memory is laundered by every restart. */
export interface ReportConfig {
  enabled: boolean;
  frequency: ReportFrequency;
  /** UTC hour of the fire, 0–23. UTC because the server's local zone is a
   *  deployment accident the schedule should not inherit. */
  hour: number;
  recipients: string[];
  /** Set only when a report was genuinely emailed (or demo-swallowed) —
   *  "last sent" must never claim a fire that skipped or failed. */
  lastSentAt?: string;
  /** Every fire, whatever its outcome. */
  lastAttemptAt?: string;
  lastResult?: 'sent' | 'failed' | 'demo' | 'skipped';
  lastError?: string;
}

export const DEFAULT_REPORT_CONFIG: Pick<ReportConfig, 'enabled' | 'frequency' | 'hour' | 'recipients'> = {
  enabled: false,
  frequency: 'daily',
  hour: 6,
  recipients: [],
};

export interface ReportDueCheck {
  due: boolean;
  /** Why — surfaced verbatim in the UI and the audit log, so "the report
   *  did not go out" always comes with its reason. */
  reason: string;
}

/**
 * The gate, in order: force → enabled → scheduled UTC hour → weekly fires
 * Monday → minimum gap since the last fire. `force` is the test button: it
 * bypasses the clock (hour, Monday, gap) and the enabled flag — an operator
 * pressing Send now is the schedule's one explicit override — but never the
 * SMTP-configured and recipient checks, which are about whether a send is
 * possible at all.
 */
export function reportDue(config: ReportConfig, nowMs: number, force = false): ReportDueCheck {
  if (force) return { due: true, reason: 'forced — an operator asked for it now' };
  if (!config.enabled) return { due: false, reason: 'the report is disabled' };
  const now = new Date(nowMs);
  if (now.getUTCHours() !== config.hour) {
    return { due: false, reason: `scheduled for ${String(config.hour).padStart(2, '0')}:00 UTC` };
  }
  if (config.frequency === 'weekly' && now.getUTCDay() !== 1) {
    return { due: false, reason: 'weekly reports fire on Mondays' };
  }
  const last = latestOf(config.lastSentAt, config.lastAttemptAt);
  if (last !== null) {
    const gap = REPORT_MIN_GAP_MS[config.frequency];
    if (nowMs - last < gap) {
      const hours = Math.max(1, Math.round(gap / 3_600_000));
      return { due: false, reason: `last fired ${new Date(last).toISOString()} — the ${hours}h minimum gap has not elapsed` };
    }
  }
  return { due: true, reason: `scheduled ${config.frequency} report at ${String(config.hour).padStart(2, '0')}:00 UTC` };
}

function latestOf(...isos: (string | undefined)[]): number | null {
  let best: number | null = null;
  for (const iso of isos) {
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

/** Field-level errors for a report-config save. Empty = valid. */
export function validateReportConfig(form: { frequency: ReportFrequency; hour: number; recipients: string[] }): string[] {
  const errors: string[] = [];
  if (!isReportFrequency(form.frequency)) errors.push('frequency must be daily or weekly');
  if (!Number.isInteger(form.hour) || form.hour < 0 || form.hour > 23) {
    errors.push('hour must be an integer between 0 and 23 (UTC)');
  }
  if (!Array.isArray(form.recipients)) errors.push('recipients must be a list');
  else {
    if (form.recipients.length > MAX_REPORT_RECIPIENTS) {
      errors.push(`recipients must be ${MAX_REPORT_RECIPIENTS} or fewer`);
    }
    for (const r of form.recipients) {
      if (!isEmailAddress(r)) errors.push(`'${String(r).slice(0, 64)}' is not an email address`);
    }
  }
  return errors;
}

// -- content ----------------------------------------------------------------

/** Caps: the report is a summary, not a dump. Overflow is always counted
 *  and stated ('+N more'), never silently dropped. */
export const REPORT_OFFLINE_CAP = 25;
export const REPORT_EXPIRY_CAP = 15;
export const REPORT_EXPIRY_WINDOW_DAYS = 90;

export const REPORT_DEVICE_TYPE_ORDER = ['switch', 'ap', 'gateway', 'controller', 'sensor', 'policy'] as const;

/** The offline vocabulary the planes normalize to ('down') plus the authored
 *  fixtures' own word ('offline') — central.ts's mapping is the source. */
export function isOfflineState(state: string): boolean {
  return state === 'down' || state === 'offline';
}

/**
 * A device state a health percentage may be computed from.
 *
 * The live vocabulary is five words: adapters emit 'up', 'down', 'offline' or
 * 'unknown', and reconcile writes 'unverified' when every claimant is stale.
 * The split is between a state that was READ and one that was not — 'unknown'
 * and 'unverified' are absences, and an absence must not move a percentage in
 * either direction.
 *
 * A reported-offline device is the opposite of an absence, and dropping it
 * raises the health number by removing a device that is down — the one
 * direction this error must never run. UXI is why the test cannot be the
 * literal pair 'up'/'down': mapUxiSensor words an offline sensor 'offline',
 * as the authored fixtures do, while central/mist/aos8 normalize to 'down'.
 * isOfflineState already held that equivalence for the fleet report; the
 * health bar was the surface that did not ask it.
 *
 * A word outside those five answers false, so it neither counts as up nor
 * dilutes the denominator. An adapter that starts emitting one belongs in its
 * own normalizer (central.ts deviceState is the pattern), not here.
 */
export function isAssertableState(state: string): boolean {
  return state === 'up' || isOfflineState(state);
}

export interface FleetReportDevice {
  name: string;
  type: string;
  state: string;
  siteName?: string;
}

/** What the report needs from the notification center: when, and how loud. */
export interface FleetReportAlert {
  createdAt: string; // ISO
  severity?: string;
}

/** A subscription with its expiry already resolved to epoch ms — the caller
 *  (the server scheduler) owns reading the live hint or parsing the display
 *  date, so this builder never guesses at formats. */
export interface FleetReportSubscription {
  id: string;
  name: string;
  detail?: string;
  expiresAtMs: number;
}

export interface FleetReportInput {
  nowMs: number;
  demo: boolean;
  devices: FleetReportDevice[];
  alerts: FleetReportAlert[];
  subscriptions: FleetReportSubscription[];
  /** Data-gap sentences rendered in the report itself — a section that had
   *  nothing to count says why, it does not print a confident zero. */
  notes?: string[];
}

export interface FleetTypeTotal {
  type: string;
  total: number;
  online: number;
  offline: number;
}

export interface FleetReportExpiry {
  id: string;
  name: string;
  detail?: string;
  expiresAt: string; // YYYY-MM-DD (UTC)
  daysLeft: number;
}

export interface FleetReport {
  subject: string;
  generatedAt: string; // ISO
  demo: boolean;
  totalDevices: number;
  totalOnline: number;
  totalOffline: number;
  totals: FleetTypeTotal[];
  offline: FleetReportDevice[];
  offlineOverflow: number;
  alerts24h: number;
  alerts168h: number;
  alerts24hBySeverity: Record<string, number>;
  /** Alerts whose createdAt could not be read, so they fell out of BOTH
   *  windows. The subscription section already counts what it had to drop
   *  (FleetReportInput.notes, 'no readable expiry date'); an alert with an
   *  unreadable timestamp is the same fact about a different column, and a
   *  count that quietly excludes it is not the count it claims to be. */
  alertsUndated: number;
  expiring: FleetReportExpiry[];
  expiringOverflow: number;
  notes: string[];
  text: string;
  html: string;
}

/** The subject line, UTC-dated: 'Fleet Summary Report — YYYY-MM-DD'. */
export function fleetReportSubject(nowMs: number): string {
  return `Fleet Summary Report — ${isoDate(nowMs)}`;
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days remaining, UTC. Floor: a subscription with 89.9 days left
 *  reads 89 — the ladder prefers warning slightly early over slightly late. */
export function daysUntilExpiry(expiresAtMs: number, nowMs: number): number {
  return Math.floor((expiresAtMs - nowMs) / 86_400_000);
}

/**
 * Build the fleet summary from already-gathered rows. Pure: the scheduler
 * owns WHERE the rows come from (fixtures in demo, the poller cache live,
 * the bell store for alerts); this owns what the report says. Offline rows
 * are capped at 25 and expiring subscriptions at 15, both with the overflow
 * stated.
 */
export function buildFleetReport(input: FleetReportInput): FleetReport {
  const { nowMs } = input;
  const notes = input.notes ?? [];

  const byType = new Map<string, FleetTypeTotal>();
  const offline: FleetReportDevice[] = [];
  for (const d of input.devices) {
    const t = d.type || 'unknown';
    const row = byType.get(t) ?? { type: t, total: 0, online: 0, offline: 0 };
    row.total += 1;
    if (isOfflineState(d.state)) {
      row.offline += 1;
      offline.push(d);
    } else {
      row.online += 1;
    }
    byType.set(t, row);
  }
  const order = (t: string): number => {
    const i = (REPORT_DEVICE_TYPE_ORDER as readonly string[]).indexOf(t);
    return i === -1 ? REPORT_DEVICE_TYPE_ORDER.length : i;
  };
  const totals = [...byType.values()].sort((a, b) => order(a.type) - order(b.type) || a.type.localeCompare(b.type));
  offline.sort((a, b) => order(a.type) - order(b.type) || a.name.localeCompare(b.name));
  const offlineShown = offline.slice(0, REPORT_OFFLINE_CAP);

  let alerts24h = 0;
  let alerts168h = 0;
  const alerts24hBySeverity: Record<string, number> = {};
  let alertsUndated = 0;
  for (const a of input.alerts) {
    const at = Date.parse(a.createdAt);
    if (Number.isNaN(at)) {
      alertsUndated += 1;
      continue;
    }
    const age = nowMs - at;
    if (age < 0 || age > 168 * 3_600_000) continue;
    alerts168h += 1;
    if (age <= 24 * 3_600_000) {
      alerts24h += 1;
      if (a.severity) alerts24hBySeverity[a.severity] = (alerts24hBySeverity[a.severity] ?? 0) + 1;
    }
  }

  const expiringAll = input.subscriptions
    .map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.detail ? { detail: s.detail } : {}),
      expiresAt: isoDate(s.expiresAtMs),
      daysLeft: daysUntilExpiry(s.expiresAtMs, nowMs),
    }))
    .filter((s) => s.daysLeft <= REPORT_EXPIRY_WINDOW_DAYS)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const expiring = expiringAll.slice(0, REPORT_EXPIRY_CAP);

  const report: Omit<FleetReport, 'text' | 'html'> = {
    subject: fleetReportSubject(nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    demo: input.demo,
    totalDevices: input.devices.length,
    totalOnline: input.devices.length - offline.length,
    totalOffline: offline.length,
    totals,
    offline: offlineShown,
    offlineOverflow: offline.length - offlineShown.length,
    alerts24h,
    alerts168h,
    alerts24hBySeverity,
    alertsUndated,
    expiring,
    expiringOverflow: expiringAll.length - expiring.length,
    notes,
  };
  return { ...report, text: renderReportText(report), html: renderReportHtml(report) };
}

/** The text/plain part — aligned columns, readable in any mail client and
 *  verbatim in the UI preview's Code block. */
export function renderReportText(report: Omit<FleetReport, 'text' | 'html'>): string {
  const lines: string[] = [];
  const when = report.generatedAt.replace('T', ' ').slice(0, 16);
  lines.push(report.subject);
  lines.push(`Generated ${when} UTC${report.demo ? ' · DEMO DATA — no plane credentials' : ''}`);
  lines.push('');
  lines.push('DEVICES');
  if (report.totals.length === 0) {
    lines.push('  no device data');
  } else {
    const width = Math.max(...report.totals.map((t) => t.type.length), 'TOTAL'.length);
    const row = (t: string, total: number, online: number, offline: number): string =>
      `  ${t.padEnd(width)}  ${String(total).padStart(5)} total · ${String(online).padStart(5)} online · ${String(offline).padStart(5)} offline`;
    for (const t of report.totals) lines.push(row(t.type, t.total, t.online, t.offline));
    lines.push(row('TOTAL', report.totalDevices, report.totalOnline, report.totalOffline));
  }
  lines.push('');
  lines.push(`OFFLINE DEVICES (${report.totalOffline}${report.offlineOverflow > 0 ? `, first ${report.offline.length}` : ''})`);
  if (report.offline.length === 0) lines.push('  none');
  for (const d of report.offline) {
    lines.push(`  ${d.name} — ${d.type}${d.siteName ? ` · ${d.siteName}` : ''} · ${d.state}`);
  }
  if (report.offlineOverflow > 0) lines.push(`  +${report.offlineOverflow} more not listed`);
  lines.push('');
  lines.push('ALERTS (notification center)');
  const sev = Object.entries(report.alerts24hBySeverity)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  lines.push(`  last 24h: ${report.alerts24h}${sev ? ` (${sev})` : ''}`);
  lines.push(`  last 168h: ${report.alerts168h}`);
  if (report.alertsUndated > 0) {
    lines.push(
      `  ${report.alertsUndated} alert${report.alertsUndated === 1 ? '' : 's'} carried no readable timestamp — absent from both counts, not ignored`,
    );
  }
  lines.push('');
  lines.push(
    `SUBSCRIPTIONS EXPIRING WITHIN ${REPORT_EXPIRY_WINDOW_DAYS} DAYS (${report.expiring.length + report.expiringOverflow}${report.expiringOverflow > 0 ? `, first ${report.expiring.length}` : ''})`,
  );
  if (report.expiring.length === 0) lines.push('  none');
  for (const s of report.expiring) {
    const when = s.daysLeft < 0 ? `expired ${-s.daysLeft}d ago` : `${s.daysLeft}d left`;
    lines.push(`  ${s.name} — ${s.expiresAt} (${when})${s.detail ? ` · ${s.detail}` : ''}`);
  }
  if (report.expiringOverflow > 0) lines.push(`  +${report.expiringOverflow} more not listed`);
  if (report.notes.length > 0) {
    lines.push('');
    lines.push('DATA GAPS');
    for (const n of report.notes) lines.push(`  ${n}`);
  }
  return lines.join('\n');
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The text/html part: one self-contained document, inline styles only —
 *  mail clients strip everything else. */
export function renderReportHtml(report: Omit<FleetReport, 'text' | 'html'>): string {
  const when = report.generatedAt.replace('T', ' ').slice(0, 16);
  const th = 'style="border:1px solid #d6d9de;padding:4px 10px;text-align:left;font-size:12px;color:#5b6470;"';
  const td = 'style="border:1px solid #d6d9de;padding:4px 10px;font-size:13px;"';
  const tdAlert = 'style="border:1px solid #d6d9de;padding:4px 10px;font-size:13px;color:#b00020;font-weight:600;"';
  const h2 = 'style="font-size:13px;letter-spacing:0.08em;color:#5b6470;margin:22px 0 6px;"';
  const parts: string[] = [];
  parts.push('<!DOCTYPE html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#1b1f24;margin:24px;">');
  parts.push(`<h1 style="font-size:18px;margin:0 0 4px;">${esc(report.subject)}</h1>`);
  parts.push(
    `<p style="font-size:12px;color:#5b6470;margin:0;">Generated ${esc(when)} UTC${report.demo ? ' · <strong>DEMO DATA</strong> — no plane credentials' : ''}</p>`,
  );
  parts.push(`<h2 ${h2}>DEVICES</h2>`);
  if (report.totals.length === 0) {
    parts.push('<p style="font-size:13px;">No device data.</p>');
  } else {
    parts.push('<table style="border-collapse:collapse;">');
    parts.push(`<tr><th ${th}>Type</th><th ${th}>Total</th><th ${th}>Online</th><th ${th}>Offline</th></tr>`);
    for (const t of [...report.totals, { type: 'TOTAL', total: report.totalDevices, online: report.totalOnline, offline: report.totalOffline }]) {
      parts.push(
        `<tr><td ${td}>${esc(t.type)}</td><td ${td}>${t.total}</td><td ${td}>${t.online}</td><td ${t.offline > 0 ? tdAlert : td}>${t.offline}</td></tr>`,
      );
    }
    parts.push('</table>');
  }
  parts.push(
    `<h2 ${h2}>OFFLINE DEVICES (${report.totalOffline}${report.offlineOverflow > 0 ? `, FIRST ${report.offline.length}` : ''})</h2>`,
  );
  if (report.offline.length === 0) {
    parts.push('<p style="font-size:13px;">None.</p>');
  } else {
    parts.push('<table style="border-collapse:collapse;">');
    parts.push(`<tr><th ${th}>Device</th><th ${th}>Type</th><th ${th}>Site</th><th ${th}>State</th></tr>`);
    for (const d of report.offline) {
      parts.push(`<tr><td ${td}>${esc(d.name)}</td><td ${td}>${esc(d.type)}</td><td ${td}>${esc(d.siteName ?? '—')}</td><td ${td}>${esc(d.state)}</td></tr>`);
    }
    parts.push('</table>');
    if (report.offlineOverflow > 0) {
      parts.push(`<p style="font-size:12px;color:#5b6470;">+${report.offlineOverflow} more not listed.</p>`);
    }
  }
  parts.push(`<h2 ${h2}>ALERTS (NOTIFICATION CENTER)</h2>`);
  const sev = Object.entries(report.alerts24hBySeverity)
    .map(([k, n]) => `${esc(k)} ${n}`)
    .join(', ');
  parts.push(`<p style="font-size:13px;">Last 24h: <strong>${report.alerts24h}</strong>${sev ? ` (${sev})` : ''} · last 168h: <strong>${report.alerts168h}</strong></p>`);
  if (report.alertsUndated > 0) {
    parts.push(
      `<p style="font-size:13px;">${report.alertsUndated} alert${report.alertsUndated === 1 ? '' : 's'} carried no readable timestamp — absent from both counts, not ignored.</p>`,
    );
  }
  parts.push(
    `<h2 ${h2}>SUBSCRIPTIONS EXPIRING WITHIN ${REPORT_EXPIRY_WINDOW_DAYS} DAYS (${report.expiring.length + report.expiringOverflow})</h2>`,
  );
  if (report.expiring.length === 0) {
    parts.push('<p style="font-size:13px;">None.</p>');
  } else {
    parts.push('<table style="border-collapse:collapse;">');
    parts.push(`<tr><th ${th}>Subscription</th><th ${th}>Expires</th><th ${th}>Left</th><th ${th}>Detail</th></tr>`);
    for (const s of report.expiring) {
      const left = s.daysLeft < 0 ? `expired ${-s.daysLeft}d ago` : `${s.daysLeft}d`;
      parts.push(
        `<tr><td ${td}>${esc(s.name)}</td><td ${td}>${esc(s.expiresAt)}</td><td ${s.daysLeft <= 15 ? tdAlert : td}>${esc(left)}</td><td ${td}>${esc(s.detail ?? '—')}</td></tr>`,
      );
    }
    parts.push('</table>');
    if (report.expiringOverflow > 0) {
      parts.push(`<p style="font-size:12px;color:#5b6470;">+${report.expiringOverflow} more not listed.</p>`);
    }
  }
  if (report.notes.length > 0) {
    parts.push(`<h2 ${h2}>DATA GAPS</h2><ul style="font-size:13px;margin:0;padding-left:18px;">`);
    for (const n of report.notes) parts.push(`<li>${esc(n)}</li>`);
    parts.push('</ul>');
  }
  parts.push('</body></html>');
  return parts.join('\n');
}

/** The honest answer a report send (or test send) returns: what actually
 *  happened, verbatim. */
export interface ReportSendResult {
  ok: boolean;
  message: string;
  demo?: boolean;
  /** True only when bytes actually left for an SMTP server. */
  emailed?: boolean;
  ms: number;
}

/** A would-have-sent report, kept when demo mode swallowed it — the email
 *  channel's twin of the webhook demo outbox. */
export interface ReportOutboxEntry {
  id: string;
  at: string; // ISO
  subject: string;
  recipients: string[];
  text: string;
  html: string;
  demo: true;
}

// ---------------------------------------------------------------------------
// The expiry ladder
// ---------------------------------------------------------------------------

/** The gates: 90, 60, 30, 15 days out. An item with D days left matches
 *  every threshold ≥ D; its band is the tightest (smallest) match. */
export const EXPIRY_THRESHOLDS: readonly number[] = [90, 60, 30, 15];

export interface ExpiringItem {
  /** Stable identity of the THING (a subscription sku+name, an ssl host row
   *  id, the demo cert's fixed id) — the event key adds the expiry date. */
  id: string;
  kind: 'subscription' | 'certificate';
  name: string;
  detail?: string;
  expiresAtMs: number;
  /** The demo showcase's items — bell entries from them are labelled demo. */
  demo?: boolean;
}

export interface ExpiryNotice {
  key: string;
  item: ExpiringItem;
  band: number;
  daysLeft: number;
}

/** eventKey → the tightest band already notified for that event. Persisted
 *  by the server store so a restart does not re-notify. */
export type ExpiryLadderState = Record<string, number>;

/** Tightest threshold ≥ daysLeft; null when the item is not on the ladder
 *  yet (further out than the widest gate). An already-expired item sits in
 *  the tightest band. */
export function expiryBand(daysLeft: number): number | null {
  let band: number | null = null;
  for (const t of EXPIRY_THRESHOLDS) {
    if (t >= daysLeft && (band === null || t < band)) band = t;
  }
  return band;
}

/** The dedup key names the EVENT, not the thing: '{id}@{expiryDate}'. A
 *  renewal moves the expiry date, the key changes, and the whole ladder
 *  re-arms — while the SAME expiry can never notify the same band twice. */
export function expiryEventKey(item: ExpiringItem): string {
  return `${item.id}@${isoDate(item.expiresAtMs)}`;
}

/**
 * One ladder pass. For every item on the ladder: notify when its band is
 * tighter than anything this event has notified before (or when the event
 * is new), and remember the tightest band notified. The returned state
 * carries ONLY events still on the ladder — a key whose item left (renewed
 * away, removed) is pruned, keeping the persisted map bounded.
 *
 * Duplicate keys within one pass keep the FIRST item — the caller feeds the
 * list in a deliberate order (real data before demo garnish).
 */
export function evaluateExpiryLadder(
  items: readonly ExpiringItem[],
  previous: ExpiryLadderState,
  nowMs: number,
): { notices: ExpiryNotice[]; state: ExpiryLadderState } {
  const notices: ExpiryNotice[] = [];
  const state: ExpiryLadderState = {};
  const seen = new Set<string>();
  for (const item of items) {
    const key = expiryEventKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const daysLeft = daysUntilExpiry(item.expiresAtMs, nowMs);
    const band = expiryBand(daysLeft);
    if (band === null) continue;
    const recorded = previous[key];
    if (recorded === undefined || band < recorded) {
      notices.push({ key, item, band, daysLeft });
      state[key] = band;
    } else {
      state[key] = recorded;
    }
  }
  return { notices, state };
}

/** Parse the licence table's own display date ('14 Sep 26', '02 Mar 28',
 *  also '14 Sep 2026' and the support-contract rows' 'support 31 Jan 27')
 *  or an ISO date to epoch ms (UTC midnight). Null when the text is not a
 *  date — the caller skips that row and says so, rather than inventing one. */
export function parseShortExpiryDate(text: string): number | null {
  const v = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) {
    const ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(ms) ? null : ms;
  }
  const m = /^(?:support )?(\d{1,2}) ([A-Za-z]{3}) (\d{2}|\d{4})$/.exec(v);
  if (!m) return null;
  const month = SHORT_MONTHS.indexOf(m[2]!.toLowerCase());
  if (month === -1) return null;
  const rawYear = Number(m[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  return Date.UTC(year, month, Number(m[1]));
}

const SHORT_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ---------------------------------------------------------------------------
// SSL certificate watch
// ---------------------------------------------------------------------------

export const SSL_DEFAULT_PORT = 443;
export const MAX_SSL_HOSTS = 50;
/** How often a host is re-probed by the scheduler (the probe-now button is
 *  the operator's override). */
export const SSL_PROBE_INTERVAL_MS = 6 * 3_600_000;

export interface SslProbeResult {
  at: string; // ISO
  ok: boolean;
  /** Certificate expiry, ISO — the ladder's input. */
  notAfter?: string;
  daysLeft?: number;
  /** Verbatim transport/TLS error on failure — a host that cannot be probed
   *  says so on its row, it does not pass for a quiet one. */
  error?: string;
}

export interface SslProbeHost {
  id: string;
  host: string;
  port: number;
  addedAt: string; // ISO
  lastProbe?: SslProbeResult;
}

/** Parse 'host[:port]' for the add form. Returns an error string on junk —
 *  refusing rather than repairing, the repo's rule. */
export function parseSslTarget(input: string): { host: string; port: number } | string {
  const v = input.trim();
  if (!v) return 'host is required';
  let host = v;
  let port = SSL_DEFAULT_PORT;
  const colon = v.lastIndexOf(':');
  if (colon !== -1) {
    const tail = v.slice(colon + 1);
    if (!/^\d+$/.test(tail)) return `'${v.slice(0, 64)}' is not host[:port] — IPv6 literals are not supported`;
    host = v.slice(0, colon);
    port = Number(tail);
    if (port < 1 || port > 65535) return 'port must be between 1 and 65535';
  }
  if (!host) return 'host is required';
  if (host.length > 255) return 'host must be 255 characters or fewer';
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes('..')) {
    return `'${host.slice(0, 64)}' is not a hostname`;
  }
  return { host: host.toLowerCase(), port };
}
