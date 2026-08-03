/**
 * server/src/services/reports.ts — the scheduled fleet summary report, the
 * SSL certificate watch, and the expiry ladder's scheduler half.
 *
 * One interval (its own — the poller is deliberately untouched) drives two
 * jobs:
 *
 *   - THE FLEET REPORT. Every tick asks the pure gate (shared/expiry.ts
 *     reportDue): enabled → scheduled UTC hour → Monday for weekly → the
 *     minimum gap since the last fire. A due fire builds the report from the
 *     SAME source decisions the screens make (devices and subscriptions
 *     follow their section's demo/live source with the blend swap, alerts
 *     come from the notification center) and emails it through the stored
 *     SMTP config. The test button is the same path with force=true — the
 *     clock is bypassed, the honesty is not: demo mode renders into the
 *     outbox and never dials, a missing SMTP config is a recorded 'skipped',
 *     a failed send is a recorded 'failed' with the server's own words.
 *
 *   - THE EXPIRY LADDER. Subscriptions (from the licences source) and SSL
 *     certificate expiries (from probing the watch list) walk the 90/60/30/15
 *     thresholds; each crossing pushes one bell entry and one audit line,
 *     once per band per EVENT ('{id}@{expiryDate}', persisted — a restart
 *     does not re-notify, a renewal re-arms). Demo mode adds one labelled
 *     demo certificate so the ladder is visible without credentials.
 *
 * The demo rule is the notifier's own, verbatim: DEMO MODE NEVER DIALS. No
 * SMTP session, no TLS probe — the report renders into a visible outbox and
 * the demo certificate walks the ladder instead.
 *
 * Bounds: one unref'd interval, one tick at a time (in-flight lock), SSL
 * probes sequential with a 10s timeout and a 6h cadence per host, a capped
 * in-memory report outbox. Nothing here grows or waits without a ceiling.
 */

import * as tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import {
  DEVICES,
  NOTIFICATION_CENTER_CAPACITY,
  SSL_PROBE_INTERVAL_MS,
  SUBSCRIPTIONS,
  buildFleetReport,
  evaluateExpiryLadder,
  isoDate,
  parseShortExpiryDate,
  reportDue,
  type ExpiringItem,
  type FleetReport,
  type FleetReportAlert,
  type FleetReportDevice,
  type FleetReportSubscription,
  type ReportConfig,
  type ReportOutboxEntry,
  type ReportSendResult,
  type SslProbeHost,
} from '@hpe/shared';
import { effectiveSectionSource, settings } from '../config/settings';
import { poller } from './poller';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { notificationCenter, type NotificationCenterStore } from './notificationCenter';
import { notificationStore, type NotificationStore } from './notifierStore';
import { sendMail } from './smtp';
import type { SubscriptionMetricHints } from '../planes/greenlake';

/** What the subscription source returns: rows with a readable expiry, a
 *  count of rows whose date could NOT be read (surfaced as a data gap,
 *  never silently dropped), and whether the source was the demo fixtures. */
export interface SubscriptionFeed {
  rows: FleetReportSubscription[];
  unparsed: number;
  demo: boolean;
}

export interface ReportServiceOptions {
  store?: NotificationStore; // default: the process-wide singleton
  center?: NotificationCenterStore; // default: the bell's singleton
  demoMode?: () => boolean; // default: the settings store
  intervalMs?: number; // tick cadence, default 60s
  sslProbeIntervalMs?: number; // per-host probe cadence, default 6h
  probeTimeoutMs?: number; // per-probe ceiling, default 10s
  nowMs?: () => number; // injected clock for tests
  dataDir?: string; // audit-log destination, default: HPE_DATA_DIR or <repo>/data
  outboxCapacity?: number; // demo report outbox ring size, default 10
  sendMailImpl?: typeof sendMail; // tests inject a spy
  probeImpl?: typeof probeCertificate; // tests inject a fake
  devices?: () => FleetReportDevice[]; // default: the devices screen's source decision
  subscriptions?: () => SubscriptionFeed; // default: the licences screen's source decision
  alerts?: () => FleetReportAlert[]; // default: the notification center
}

/** The devices screen's own source decision (notifier.ts's blend idiom):
 *  demo fixtures, live poller rows, or the blend swap. */
function defaultDevices(): FleetReportDevice[] {
  const s = settings.get();
  const live = poller.getCache().devices as FleetReportDevice[];
  if (effectiveSectionSource(s, 'devices') === 'demo') {
    const blend = s.blendLive === true && s.sectionMode?.devices !== 'demo';
    return blend && live.length > 0 ? live : DEVICES;
  }
  return live;
}

/** The licences screen's own source decision. Live rows carry the GreenLake
 *  adapter's expiresAtMs hint; demo rows carry the table's display date,
 *  parsed here — a row whose date reads as neither is COUNTED as unparsed,
 *  not given a made-up one. */
function defaultSubscriptions(): SubscriptionFeed {
  const s = settings.get();
  const live = poller.getCache().subscriptions as (typeof SUBSCRIPTIONS[number] & SubscriptionMetricHints)[];
  const demoSource = effectiveSectionSource(s, 'licenses') === 'demo';
  let rows = live;
  let demo = false;
  if (demoSource) {
    const blend = s.blendLive === true && s.sectionMode?.licenses !== 'demo';
    if (blend && live.length > 0) rows = live;
    else {
      rows = SUBSCRIPTIONS;
      demo = true;
    }
  }
  const out: FleetReportSubscription[] = [];
  let unparsed = 0;
  for (const row of rows) {
    const expiresAtMs = row.expiresAtMs ?? parseShortExpiryDate(row.expires ?? '');
    if (expiresAtMs === null || Number.isNaN(expiresAtMs)) {
      unparsed += 1;
      continue;
    }
    out.push({ id: `sub|${row.sku}|${row.name}`, name: row.name, detail: row.sku, expiresAtMs });
  }
  return { rows: out, unparsed, demo };
}

export interface CertProbe {
  ok: boolean;
  notAfter?: string; // ISO
  error?: string;
}

/**
 * Probe one host's TLS certificate expiry: connect, read the peer
 * certificate's valid_to, done. Verification is deliberately OFF — the
 * question here is "when does this certificate expire", not "do we trust
 * it", and refusing untrusted chains would hide exactly the self-signed
 * internal certificates that expire silently. Never throws: a failure is
 * the probe's answer, recorded on the host row and skipped by the ladder.
 */
export function probeCertificate(host: string, port: number, timeoutMs = 10_000): Promise<CertProbe> {
  return new Promise((resolve) => {
    let done = false;
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false });
    const finish = (result: CertProbe) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () =>
      finish({ ok: false, error: `no response from ${host}:${port} for ${timeoutMs}ms — probe timed out` }),
    );
    socket.once('secureConnect', () => {
      const notAfter = socket.getPeerCertificate()?.valid_to;
      if (!notAfter) {
        finish({ ok: false, error: 'the server presented no certificate' });
        return;
      }
      const ms = Date.parse(notAfter);
      if (Number.isNaN(ms)) {
        finish({ ok: false, error: `unreadable certificate expiry '${notAfter}'` });
        return;
      }
      finish({ ok: true, notAfter: new Date(ms).toISOString() });
    });
    socket.once('error', (err) => finish({ ok: false, error: err.message }));
  });
}

export class ReportService {
  private readonly store: NotificationStore;
  private readonly center: NotificationCenterStore;
  private readonly demoMode: () => boolean;
  private readonly intervalMs: number;
  private readonly sslProbeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly nowMs: () => number;
  private readonly dataDir: string;
  private readonly outboxCapacity: number;
  private readonly sendMailImpl: typeof sendMail;
  private readonly probeImpl: typeof probeCertificate;
  private readonly devicesSource: () => FleetReportDevice[];
  private readonly subscriptionsSource: () => SubscriptionFeed;
  private readonly alertsSource: () => FleetReportAlert[];

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private outboxEntries: ReportOutboxEntry[] = [];

  constructor(opts: ReportServiceOptions = {}) {
    this.store = opts.store ?? notificationStore;
    this.center = opts.center ?? notificationCenter;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.sslProbeIntervalMs = opts.sslProbeIntervalMs ?? SSL_PROBE_INTERVAL_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 10_000;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.outboxCapacity = opts.outboxCapacity ?? 10;
    this.sendMailImpl = opts.sendMailImpl ?? sendMail;
    this.probeImpl = opts.probeImpl ?? probeCertificate;
    this.devicesSource = opts.devices ?? defaultDevices;
    this.subscriptionsSource = opts.subscriptions ?? defaultSubscriptions;
    this.alertsSource =
      opts.alerts ??
      (() =>
        this.center
          .list(NOTIFICATION_CENTER_CAPACITY)
          .entries.map((e) => ({ createdAt: e.createdAt, severity: e.severity })));
  }

  /** One unref'd interval plus one immediate tick — the notifier's own rule:
   *  the timer never keeps the process alive, and a boot inside the
   *  scheduled hour is not a reason to skip today's report (the min-gap
   *  stops a restart from double-sending). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tickNow();
    }, this.intervalMs);
    this.timer.unref();
    void this.tickNow();
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

  /** Whether this process is in demo mode — the route reports it alongside
   *  the report config so the UI can label honestly. */
  isDemoMode(): boolean {
    return this.demoMode();
  }

  /** The demo report outbox, newest first. Only fills when demo mode (or a
   *  demo test send) swallowed a would-have-been email. */
  outbox(): ReportOutboxEntry[] {
    return [...this.outboxEntries];
  }

  /** One scheduler pass: the report gate, then the expiry ladder. One at a
   *  time — a slow SMTP server must never let two ticks overlap. */
  async tickNow(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.nowMs();
      await this.maybeSendReport(now);
      await this.scanExpiry(now);
    } finally {
      this.ticking = false;
    }
  }

  /** The scheduled path: ask the gate, fire only when it says due. */
  private async maybeSendReport(nowMs: number): Promise<void> {
    const config = this.store.report();
    const check = reportDue(config, nowMs);
    if (!check.due) return;
    await this.fire(config, nowMs, check.reason);
  }

  /** The operator's Send now: the same fire with the clock bypassed. The
   *  result message is served verbatim by the route. */
  async sendReportNow(): Promise<ReportSendResult> {
    const now = this.nowMs();
    const config = this.store.report();
    return this.fire(config, now, 'forced — an operator asked for it now');
  }

  /**
   * Build + deliver (or honestly not-deliver) one report. Never throws —
   * every outcome is recorded on the config row and audit-logged.
   */
  private async fire(config: ReportConfig, nowMs: number, reason: string): Promise<ReportSendResult> {
    const started = this.nowMs();
    const report = await this.buildPreview(nowMs);
    const at = new Date(nowMs).toISOString();

    if (this.demoMode()) {
      this.pushOutbox({
        id: `rpt-${nowMs.toString(36)}${randomBytes(3).toString('hex')}`,
        at,
        subject: report.subject,
        recipients: config.recipients,
        text: report.text,
        html: report.html,
        demo: true,
      });
      this.store.recordReportFire({ at, result: 'demo' });
      this.audit('notification-report-demo', `demo mode — no network call; the rendered report is in the outbox (${reason})`);
      return {
        ok: true,
        demo: true,
        ms: this.nowMs() - started,
        message: 'Demo mode — nothing was emailed. The rendered report is in the outbox.',
      };
    }

    const smtp = this.store.smtp();
    if (!smtp) {
      this.store.recordReportFire({ at, result: 'skipped', error: 'SMTP is not configured' });
      this.audit('notification-report-skipped', `SMTP is not configured — the report was rendered but not emailed (${reason})`);
      return {
        ok: false,
        emailed: false,
        ms: this.nowMs() - started,
        message: 'SMTP is not configured — nothing was emailed. The preview shows exactly what would be sent.',
      };
    }
    if (config.recipients.length === 0) {
      this.store.recordReportFire({ at, result: 'skipped', error: 'no recipients configured' });
      this.audit('notification-report-skipped', `no recipients configured — the report was rendered but not emailed (${reason})`);
      return {
        ok: false,
        emailed: false,
        ms: this.nowMs() - started,
        message: 'The report has no recipients — add at least one before it can be emailed.',
      };
    }

    try {
      const sent = await this.sendMailImpl(smtp, {
        to: config.recipients,
        subject: report.subject,
        text: report.text,
        html: report.html,
      });
      this.store.recordReportFire({ at, result: 'sent' });
      this.audit(
        'notification-report-sent',
        `emailed to ${config.recipients.join(', ')} via ${smtp.host}:${smtp.port} in ${sent.ms}ms (${reason})`,
      );
      return {
        ok: true,
        emailed: true,
        ms: sent.ms,
        message: `Emailed to ${config.recipients.join(', ')} — ${smtp.host}:${smtp.port} accepted it.`,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.store.recordReportFire({ at, result: 'failed', error: message });
      this.audit('notification-report-failed', `${message} (${reason})`);
      return { ok: false, emailed: false, ms: this.nowMs() - started, message };
    }
  }

  /** The report exactly as it would send right now — the UI's preview and
   *  the fire path share this, so what you see is literally what goes out. */
  async buildPreview(nowMs: number = this.nowMs()): Promise<FleetReport> {
    const devices = this.devicesSource();
    const subs = this.subscriptionsSource();
    const alerts = this.alertsSource();
    const notes: string[] = [];
    if (devices.length === 0) notes.push('no device data — no plane has reported a device');
    if (subs.rows.length === 0 && subs.unparsed === 0) {
      notes.push('no subscription data — no entitlement plane has reported');
    }
    if (subs.unparsed > 0) {
      notes.push(
        `${subs.unparsed} subscription row${subs.unparsed === 1 ? '' : 's'} carried no readable expiry date — absent from the expiry section, not ignored`,
      );
    }
    return buildFleetReport({ nowMs, demo: this.demoMode(), devices, alerts, subscriptions: subs.rows, notes });
  }

  /** One honest test email down the real path (default recipient: the
   *  configured sender). Same rules as the notifier's testEndpoint. */
  async testSmtp(to?: string): Promise<ReportSendResult> {
    const started = this.nowMs();
    const smtp = this.store.smtp();
    if (!smtp) return { ok: false, ms: 0, message: 'SMTP is not configured — save one first.' };
    const recipient = to ?? smtp.from;
    const subject = 'HPE Network Tools — SMTP test';
    const text =
      `This is a test email from HPE Network Tools.\n\n` +
      `An operator pressed Test on the Systems screen. Nothing fired; this proves the configured ` +
      `relay (${smtp.host}:${smtp.port}${smtp.tls ? ', STARTTLS' : ', plaintext'}) accepts mail for ${recipient}.`;
    const html = `<p>This is a test email from <strong>HPE Network Tools</strong>.</p><p>An operator pressed Test on the Systems screen. Nothing fired; this proves the configured relay accepts mail for ${recipient}.</p>`;
    if (this.demoMode()) {
      const at = new Date(this.nowMs()).toISOString();
      this.pushOutbox({
        id: `rpt-${this.nowMs().toString(36)}${randomBytes(3).toString('hex')}`,
        at,
        subject,
        recipients: [recipient],
        text,
        html,
        demo: true,
      });
      this.audit('notification-smtp-test-demo', `demo mode — no network call; the test email for ${recipient} is in the outbox`);
      return {
        ok: true,
        demo: true,
        ms: this.nowMs() - started,
        message: 'Demo mode — nothing was sent. The would-have-sent email is in the report outbox.',
      };
    }
    try {
      const sent = await this.sendMailImpl(smtp, { to: [recipient], subject, text, html });
      this.audit('notification-smtp-test', `test email accepted by ${smtp.host}:${smtp.port} for ${recipient} in ${sent.ms}ms`);
      return {
        ok: true,
        emailed: true,
        ms: sent.ms,
        message: `Delivered — ${smtp.host}:${smtp.port} accepted the test email for ${recipient}.`,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.audit('notification-smtp-test-failed', message);
      return { ok: false, emailed: false, ms: this.nowMs() - started, message };
    }
  }

  /**
   * The ladder pass: probe due SSL hosts (never in demo mode), gather every
   * expiring thing, evaluate against the persisted state, bell + audit each
   * crossing, persist the new state.
   */
  private async scanExpiry(nowMs: number): Promise<void> {
    if (!this.demoMode()) {
      for (const host of this.store.sslHosts()) {
        const last = host.lastProbe ? Date.parse(host.lastProbe.at) : null;
        if (last !== null && !Number.isNaN(last) && nowMs - last < this.sslProbeIntervalMs) continue;
        await this.probeAndRecord(host, nowMs);
      }
    }

    const items: ExpiringItem[] = [];
    const subs = this.subscriptionsSource();
    for (const s of subs.rows) {
      items.push({
        id: s.id,
        kind: 'subscription',
        name: s.name,
        ...(s.detail ? { detail: s.detail } : {}),
        expiresAtMs: s.expiresAtMs,
        ...(subs.demo ? { demo: true } : {}),
      });
    }
    for (const host of this.store.sslHosts()) {
      const probe = host.lastProbe;
      if (!probe?.ok || !probe.notAfter) continue; // failures stay on the row, never enter the ladder
      const expiresAtMs = Date.parse(probe.notAfter);
      if (Number.isNaN(expiresAtMs)) continue;
      items.push({ id: `ssl|${host.id}`, kind: 'certificate', name: `${host.host}:${host.port} TLS certificate`, expiresAtMs });
    }
    if (this.demoMode()) items.push(this.demoCertItem(nowMs));

    const previous = this.store.expiryLadderState();
    const { notices, state } = evaluateExpiryLadder(items, previous, nowMs);
    for (const notice of notices) {
      const expired = notice.daysLeft < 0;
      this.center.push({
        title: expired ? `${notice.item.name} expired` : `${notice.item.name} — expires in ${notice.daysLeft}d`,
        body:
          `${notice.item.kind === 'subscription' ? 'Subscription' : 'Certificate'} crossed the ${notice.band}d ` +
          `threshold · expires ${isoDate(notice.item.expiresAtMs)}${notice.item.detail ? ` · ${notice.item.detail}` : ''}`,
        severity: notice.band <= 15 ? 'danger' : notice.band <= 30 ? 'warning' : 'info',
        // Certificates have no screen of their own — a bell entry that links
        // nowhere beats one that 404s (alertRules' own rule).
        ...(notice.item.kind === 'subscription' ? { url: '/licenses' } : {}),
        ...(notice.item.demo ? { demo: true } : {}),
      });
      this.audit(
        'expiry-notice',
        `${notice.item.name} crossed the ${notice.band}d threshold (${expired ? `expired ${-notice.daysLeft}d ago` : `${notice.daysLeft}d left`})`,
      );
    }
    // Persist when anything notified or the pruned set changed — a no-change
    // pass writes nothing (the file is not a heartbeat).
    if (notices.length > 0 || Object.keys(state).length !== Object.keys(previous).length) {
      this.store.saveExpiryLadderState(state);
    }
  }

  /** The demo ladder's certificate: 21 days out from first sight, the date
   *  STAMPED IN THE STORE so its event key is stable (a `now + 21d`
   *  recomputed each tick would be a new key every day and re-notify daily).
   *  Labelled demo everywhere it lands. */
  private demoCertItem(nowMs: number): ExpiringItem {
    let iso = this.store.demoCertExpiresAt();
    if (!iso) {
      iso = new Date(nowMs + 21 * 86_400_000).toISOString();
      this.store.setDemoCertExpiresAt(iso);
    }
    return {
      id: 'demo-cert',
      kind: 'certificate',
      name: 'portal.demo.local TLS certificate',
      detail: 'demo item — no probe is made in demo mode',
      expiresAtMs: Date.parse(iso),
      demo: true,
    };
  }

  /** The probe-now button: one explicit re-probe. Demo mode answers honestly
   *  instead of dialling. Null = unknown id (the route 404s). */
  async probeHostNow(id: string): Promise<{ host: SslProbeHost } | { demo: true; message: string } | null> {
    const host = this.store.sslHosts().find((h) => h.id === id);
    if (!host) return null;
    if (this.demoMode()) {
      return { demo: true, message: 'Demo mode — probes never dial. The demo certificate walks the ladder instead.' };
    }
    await this.probeAndRecord(host, this.nowMs());
    const fresh = this.store.sslHosts().find((h) => h.id === id);
    return fresh ? { host: fresh } : null;
  }

  /** One probe, recorded on the row either way. A failure is a console line
   *  and the row's lastProbe.error — logged + skipped honestly. */
  private async probeAndRecord(host: SslProbeHost, nowMs: number): Promise<void> {
    const at = new Date(nowMs).toISOString();
    try {
      const probe = await this.probeImpl(host.host, host.port, this.probeTimeoutMs);
      const daysLeft =
        probe.ok && probe.notAfter && !Number.isNaN(Date.parse(probe.notAfter))
          ? Math.floor((Date.parse(probe.notAfter) - nowMs) / 86_400_000)
          : undefined;
      this.store.recordSslProbe(host.id, {
        at,
        ok: probe.ok,
        ...(probe.notAfter ? { notAfter: probe.notAfter } : {}),
        ...(daysLeft !== undefined ? { daysLeft } : {}),
        ...(probe.error ? { error: probe.error } : {}),
      });
      if (!probe.ok) console.error(`ssl probe ${host.host}:${host.port}: ${probe.error ?? 'failed'}`);
    } catch (err) {
      const message = (err as Error).message;
      this.store.recordSslProbe(host.id, { at, ok: false, error: message });
      console.error(`ssl probe ${host.host}:${host.port}: ${message}`);
    }
  }

  private pushOutbox(entry: ReportOutboxEntry): void {
    this.outboxEntries = [entry, ...this.outboxEntries].slice(0, this.outboxCapacity);
  }

  /** One audit-log line per fire/probe/notice. Never a payload body — the
   *  change log's rule is "what happened, never what was in it". */
  private audit(event: string, result: string): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event,
      changeId: `rpt-${this.nowMs().toString(36)}${randomBytes(3).toString('hex')}`,
      // A report is not a brokered write — nothing is pushed to a plane —
      // so no ticket authorises it, exactly like a silence.
      ticket: '—',
      kind: 'notification',
      result,
    });
  }
}

export const reportService = new ReportService();
