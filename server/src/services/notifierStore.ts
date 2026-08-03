/**
 * server/src/services/notifierStore.ts — the notification-endpoint store.
 *
 * Outbound notification endpoints (shared/notifications.ts) persist to
 * data/notifications.json (0600, atomic write, HPE_DATA_DIR override for
 * tests), the same pattern as the silence store. Like silences, endpoints are
 * real user data that apply in BOTH demo and live mode: pointing the demo
 * queue at a Slack-shaped endpoint and watching the outbox fill is how the
 * feature is tried out, and a configuration that only existed live would make
 * the demo a lie about the feature.
 *
 * The hmacSecret is write-only at this boundary: the store is the ONLY place
 * the cleartext exists, and views() — the shape every route serves — replaces
 * it with a `hmacSecretConfigured` flag. On update the secret follows the
 * keep/clear/replace tri-state: absent keeps the stored value (so an edit
 * that never touched the secret field cannot silently drop it), null clears,
 * a string replaces.
 *
 * The last delivery outcome is persisted ON the endpoint row. A send that
 * failed five minutes before a restart still failed after it — keeping that
 * only in memory would let a bounce launder a failing endpoint back to
 * "never attempted".
 *
 * The same store also keeps the EMAIL CHANNEL half (SMTP config, the fleet
 * report schedule + outcome, the SSL certificate watch list, and the expiry
 * ladder's notified bands) in a sibling file, data/notification-email.json —
 * a separate file because notifications.json is an array of endpoint rows
 * with deployments already on disk, and the email channel is singleton
 * state, not another row. Same 0600 atomic writes, same HPE_DATA_DIR
 * override, and the same redaction rule: the SMTP password exists in
 * cleartext only inside this store; smtpView() replaces it with a
 * `passwordConfigured` flag, and on update it follows the hmacSecret
 * tri-state (absent keeps, null clears, a string replaces).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ExpiryLadderState,
  NotificationDelivery,
  NotificationEndpoint,
  NotificationEndpointView,
  NotificationTemplateKind,
  ReportConfig,
  SmtpConfig,
  SmtpConfigView,
  SslProbeHost,
  SslProbeResult,
} from '@hpe/shared';
import { DEFAULT_REPORT_CONFIG } from '@hpe/shared';
import { brokerDataDir } from './writeBroker';

/** What a create/update needs from the route — validated there; the store
 *  stamps the rest. `hmacSecret`: absent keeps (update only), null clears,
 *  string replaces. */
export interface NotificationEndpointInput {
  name: string;
  url: string;
  template: NotificationTemplateKind;
  hmacSecret?: string | null;
  enabled: boolean;
}

/** What an SMTP save needs from the route — validated there; the store
 *  stamps updatedAt. `password`: absent keeps (update only), null clears,
 *  a string replaces. `user`: a non-empty string sets; anything else clears
 *  (the username is not secret, the form round-trips it). */
export interface SmtpConfigInput {
  host: string;
  port: number;
  user?: string;
  password?: string | null;
  from: string;
  tls: boolean;
}

/** The email-channel sibling file's shape — singleton config, not rows. */
interface EmailChannelState {
  smtp?: SmtpConfig;
  report?: ReportConfig;
  sslHosts?: SslProbeHost[];
  /** eventKey → tightest band already notified (shared/expiry.ts). */
  expiryLadder?: ExpiryLadderState;
  /** The demo certificate's expiry, stamped once so its ladder event key is
   *  stable across ticks and restarts (a drifting date would re-arm daily). */
  demoCertExpiresAt?: string;
}

export class NotificationStore {
  private endpoints: NotificationEndpoint[] | null = null;

  constructor(private readonly dataDir: string = process.env.HPE_DATA_DIR ?? brokerDataDir()) {}

  private get file(): string {
    return path.join(this.dataDir, 'notifications.json');
  }

  /** Rows exactly as persisted — the basis for every mutation and write. */
  private stored(): NotificationEndpoint[] {
    if (this.endpoints !== null) return this.endpoints.map((e) => ({ ...e }));
    this.endpoints = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.endpoints = parsed as NotificationEndpoint[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`notifications: unreadable store, starting empty: ${(err as Error).message}`);
      }
    }
    return this.stored();
  }

  /** Full rows INCLUDING secrets — internal use only (the notifier signs with
   *  these). Routes serve views(). */
  list(): NotificationEndpoint[] {
    return this.stored();
  }

  /** Every endpoint, secret redacted to a configured flag. */
  views(): NotificationEndpointView[] {
    return this.stored().map((e) => toView(e));
  }

  /** One full row by id, or null. */
  get(id: string): NotificationEndpoint | null {
    return this.stored().find((e) => e.id === id) ?? null;
  }

  create(input: NotificationEndpointInput, now: number = Date.now()): NotificationEndpoint {
    const endpoint: NotificationEndpoint = {
      id: `ntf-${new Date(now).getTime().toString(36)}${randomBytes(3).toString('hex')}`,
      name: input.name,
      url: input.url,
      template: input.template,
      ...(input.hmacSecret ? { hmacSecret: input.hmacSecret } : {}),
      enabled: input.enabled,
      createdAt: new Date(now).toISOString(),
    };
    this.save([endpoint, ...this.stored()]);
    return endpoint;
  }

  /** Apply a partial edit. Returns null for an unknown id — the route turns
   *  that into a 404. The delivery record always survives an edit: changing
   *  the name of an endpoint must not launder its failure history. */
  update(id: string, input: Partial<NotificationEndpointInput>): NotificationEndpoint | null {
    const endpoints = this.stored();
    const idx = endpoints.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const current = endpoints[idx]!;
    const next: NotificationEndpoint = {
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.template !== undefined ? { template: input.template } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    if (input.hmacSecret === null) delete next.hmacSecret;
    else if (typeof input.hmacSecret === 'string' && input.hmacSecret) next.hmacSecret = input.hmacSecret;
    endpoints[idx] = next;
    this.save(endpoints);
    return next;
  }

  /** Enable/disable without a full edit — the same audited toggle the list
   *  row exposes. Returns null for an unknown id. */
  setEnabled(id: string, enabled: boolean): NotificationEndpoint | null {
    return this.update(id, { enabled });
  }

  remove(id: string): NotificationEndpoint | null {
    const endpoints = this.stored();
    const idx = endpoints.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const [removed] = endpoints.splice(idx, 1);
    this.save(endpoints);
    return removed ?? null;
  }

  /** Persist one delivery outcome onto its endpoint (see the header for why
   *  this is on disk and not in memory). Unknown id: the endpoint was removed
   *  mid-flight — the outcome has nowhere honest to live, so it goes to the
   *  server console instead of vanishing silently. */
  recordDelivery(id: string, delivery: NotificationDelivery): void {
    const endpoints = this.stored();
    const idx = endpoints.findIndex((e) => e.id === id);
    if (idx === -1) {
      console.error(`notifications: delivery outcome for removed endpoint ${id}: ${delivery.lastResult}`);
      return;
    }
    endpoints[idx] = { ...endpoints[idx]!, delivery };
    this.save(endpoints);
  }

  private save(endpoints: NotificationEndpoint[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(endpoints, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.endpoints = endpoints;
  }

  // -------------------------------------------------------------------------
  // Email channel — SMTP config, report schedule, SSL hosts, ladder state
  // -------------------------------------------------------------------------

  private channelState: EmailChannelState | null = null;

  private get channelFile(): string {
    return path.join(this.dataDir, 'notification-email.json');
  }

  /** The email-channel state exactly as persisted. Any read failure starts
   *  it EMPTY — the report scheduler treats a missing config as "not
   *  configured", never as an exception. */
  private channel(): EmailChannelState {
    if (this.channelState !== null) return { ...this.channelState };
    this.channelState = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.channelFile, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.channelState = parsed as EmailChannelState;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`notifications: unreadable email channel store, starting empty: ${(err as Error).message}`);
      }
    }
    return this.channel();
  }

  private saveChannel(state: EmailChannelState): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.channelFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.channelFile);
    this.channelState = state;
  }

  /** The full SMTP row INCLUDING the password — internal use only (the
   *  mailer authenticates with it). Routes serve smtpView(). */
  smtp(): SmtpConfig | null {
    return this.channel().smtp ?? null;
  }

  /** The SMTP row with the password redacted to a configured flag. */
  smtpView(): SmtpConfigView | null {
    const config = this.smtp();
    return config ? toSmtpView(config) : null;
  }

  /** Create or replace the SMTP config. The password tri-state is against
   *  the EXISTING row, so an edit that never touched the password field
   *  cannot silently drop it. */
  setSmtp(input: SmtpConfigInput, now: number = Date.now()): SmtpConfig {
    const existing = this.smtp();
    const next: SmtpConfig = {
      host: input.host,
      port: input.port,
      ...(input.user ? { user: input.user } : {}),
      from: input.from,
      tls: input.tls,
      updatedAt: new Date(now).toISOString(),
    };
    if (typeof input.password === 'string' && input.password) next.password = input.password;
    else if (input.password !== null && existing?.password) next.password = existing.password;
    const ch = this.channel();
    ch.smtp = next;
    this.saveChannel(ch);
    return next;
  }

  clearSmtp(): SmtpConfig | null {
    const ch = this.channel();
    const removed = ch.smtp ?? null;
    if (removed) {
      delete ch.smtp;
      this.saveChannel(ch);
    }
    return removed;
  }

  /** The report schedule with defaults filled — absent file = disabled
   *  daily at 06:00 UTC with no recipients. */
  report(): ReportConfig {
    return { ...DEFAULT_REPORT_CONFIG, ...(this.channel().report ?? {}) };
  }

  /** Apply a route-validated partial schedule edit. The outcome fields are
   *  never touched here — only recordReportFire writes those, so a schedule
   *  edit cannot launder a failure. */
  setReport(patch: Partial<Pick<ReportConfig, 'enabled' | 'frequency' | 'hour' | 'recipients'>>): ReportConfig {
    const ch = this.channel();
    ch.report = { ...this.report(), ...patch };
    this.saveChannel(ch);
    return ch.report;
  }

  /** Persist one fire's outcome. `lastSentAt` moves only when a report was
   *  genuinely emailed or demo-swallowed — a skipped or failed fire must
   *  never read as "sent". */
  recordReportFire(fire: { at: string; result: 'sent' | 'failed' | 'demo' | 'skipped'; error?: string }): void {
    const current = this.report();
    const next: ReportConfig = {
      ...current,
      lastAttemptAt: fire.at,
      ...(fire.result === 'sent' || fire.result === 'demo' ? { lastSentAt: fire.at } : {}),
      lastResult: fire.result,
    };
    if (fire.error) next.lastError = fire.error;
    else delete next.lastError;
    const ch = this.channel();
    ch.report = next;
    this.saveChannel(ch);
  }

  sslHosts(): SslProbeHost[] {
    return (this.channel().sslHosts ?? []).map((h) => ({ ...h }));
  }

  addSslHost(target: { host: string; port: number }, now: number = Date.now()): SslProbeHost {
    const entry: SslProbeHost = {
      id: `ssl-${new Date(now).getTime().toString(36)}${randomBytes(3).toString('hex')}`,
      host: target.host,
      port: target.port,
      addedAt: new Date(now).toISOString(),
    };
    const ch = this.channel();
    ch.sslHosts = [entry, ...(ch.sslHosts ?? [])];
    this.saveChannel(ch);
    return entry;
  }

  removeSslHost(id: string): SslProbeHost | null {
    const ch = this.channel();
    const hosts = ch.sslHosts ?? [];
    const idx = hosts.findIndex((h) => h.id === id);
    if (idx === -1) return null;
    const [removed] = hosts.splice(idx, 1);
    ch.sslHosts = hosts;
    this.saveChannel(ch);
    return removed ?? null;
  }

  /** Persist one probe outcome onto its host row. Unknown id: the host was
   *  removed mid-probe — the outcome has nowhere honest to live, so it goes
   *  to the server console instead of vanishing silently. */
  recordSslProbe(id: string, probe: SslProbeResult): void {
    const ch = this.channel();
    const hosts = ch.sslHosts ?? [];
    const idx = hosts.findIndex((h) => h.id === id);
    if (idx === -1) {
      console.error(`notifications: ssl probe outcome for removed host ${id}: ${probe.ok ? 'ok' : probe.error}`);
      return;
    }
    hosts[idx] = { ...hosts[idx]!, lastProbe: probe };
    ch.sslHosts = hosts;
    this.saveChannel(ch);
  }

  /** The expiry ladder's notified bands (eventKey → band). */
  expiryLadderState(): ExpiryLadderState {
    return { ...(this.channel().expiryLadder ?? {}) };
  }

  saveExpiryLadderState(state: ExpiryLadderState): void {
    const ch = this.channel();
    ch.expiryLadder = { ...state };
    this.saveChannel(ch);
  }

  /** The demo certificate's stamped expiry (see EmailChannelState). */
  demoCertExpiresAt(): string | null {
    return this.channel().demoCertExpiresAt ?? null;
  }

  setDemoCertExpiresAt(iso: string): void {
    const ch = this.channel();
    ch.demoCertExpiresAt = iso;
    this.saveChannel(ch);
  }
}

/** The redaction boundary — the ONLY place a stored row becomes a served
 *  view, so a future field cannot leak by forgetting to strip it here. */
export function toView(endpoint: NotificationEndpoint): NotificationEndpointView {
  const { hmacSecret, ...rest } = endpoint;
  return { ...rest, hmacSecretConfigured: Boolean(hmacSecret) };
}

/** The SMTP redaction boundary — same rule as toView: the password exists
 *  as cleartext only inside this store. */
export function toSmtpView(config: SmtpConfig): SmtpConfigView {
  const { password, ...rest } = config;
  return { ...rest, passwordConfigured: Boolean(password) };
}

export const notificationStore = new NotificationStore();
