/**
 * server/tests/reports.test.ts — the report scheduler + expiry ladder
 * service (services/reports.ts) with every seam injected: clock, demo flag,
 * SMTP sender, TLS prober, and the three data sources.
 *
 * Covered:
 *   schedule — a due gate fires, an off-hour tick does not, the min-gap
 *              stops a same-hour refire, force bypasses the clock;
 *   honesty  — demo renders into the outbox and never calls the sender;
 *              live without SMTP records 'skipped' (never 'sent'); a failed
 *              send records the error verbatim; a successful send stamps
 *              lastSentAt;
 *   ladder   — a subscription crossing 90/60/30 notifies the bell once per
 *              band (a second tick does not re-notify), a renewal re-arms,
 *              demo mode adds the labelled demo certificate, SSL hosts enter
 *              the ladder from good probes while failed probes are recorded
 *              and skipped;
 *   probing  — the 6h cadence, the recorded daysLeft, the probe-now button's
 *              honest demo answer.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationCenterStore } from '../src/services/notificationCenter';
import { NotificationStore } from '../src/services/notifierStore';
import { ReportService, type SubscriptionFeed } from '../src/services/reports';
import {
  NOTIFICATION_CENTER_CAPACITY,
  type FleetReportAlert,
  type FleetReportDevice,
  type SmtpConfig,
} from '@hpe/shared';

const DAY = 86_400_000;
/** 2026-08-02 12:00 UTC — a Sunday. */
const SUNDAY = Date.UTC(2026, 7, 2, 12, 0, 0);
/** 2026-08-03 06:00 UTC — a Monday. */
const MONDAY_6AM = Date.UTC(2026, 7, 3, 6, 0, 0);

let dir: string;
let store: NotificationStore;
let center: NotificationCenterStore;
let now: number;
let demo: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hpe-reports-'));
  store = new NotificationStore(dir);
  center = new NotificationCenterStore(dir);
  now = SUNDAY;
  demo = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  service: ReportService;
  sent: { config: SmtpConfig; mail: { to: string[]; subject: string; text: string; html: string } }[];
  sendImpl: ReturnType<typeof vi.fn>;
  probes: { host: string; port: number }[];
  probeImpl: (host: string, port: number) => Promise<{ ok: boolean; notAfter?: string; error?: string }>;
  devices: FleetReportDevice[];
  subscriptions: SubscriptionFeed;
  alerts: FleetReportAlert[];
}

interface HarnessOverrides {
  devices?: FleetReportDevice[];
  subscriptions?: SubscriptionFeed;
  alerts?: FleetReportAlert[];
  probeImpl?: (host: string, port: number) => Promise<{ ok: boolean; notAfter?: string; error?: string }>;
}

function harness(over: HarnessOverrides = {}): Harness {
  // One mutable bag the service's closures read, so a test can swap sources
  // mid-flight (h.subscriptions = …) and the next tick sees it.
  const h: Harness = {
    sent: [],
    probes: [],
    sendImpl: vi.fn(),
    probeImpl: async () => ({ ok: true }),
    devices: over.devices ?? [{ name: 'sw-1', type: 'switch', state: 'up', siteName: 'Campus' }],
    subscriptions: over.subscriptions ?? { rows: [], unparsed: 0, demo: true },
    alerts: over.alerts ?? [],
    service: null as unknown as ReportService, // assigned below, before any use
  };
  h.sendImpl = vi.fn(async (config: SmtpConfig, mail: Harness['sent'][number]['mail']) => {
    h.sent.push({ config, mail });
    return { ms: 3, code: 250 };
  });
  h.probeImpl =
    over.probeImpl ??
    (async (host: string, port: number) => {
      h.probes.push({ host, port });
      return { ok: true, notAfter: new Date(now + 40 * DAY).toISOString() };
    });
  h.service = new ReportService({
    store,
    center,
    demoMode: () => demo,
    nowMs: () => now,
    dataDir: dir,
    sendMailImpl: h.sendImpl,
    probeImpl: h.probeImpl,
    devices: () => h.devices,
    subscriptions: () => h.subscriptions,
    alerts: () => h.alerts,
    intervalMs: 60_000,
  });
  return h;
}

function auditEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(join(dir, 'change-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function configureSmtp(): void {
  store.setSmtp({ host: 'smtp.example.com', port: 587, user: 'svc', password: 'pw', from: 'reports@example.com', tls: true });
}

describe('the scheduled gate', () => {
  it('a due gate fires; an off-hour tick does not; the min-gap stops a refire', async () => {
    demo = false;
    configureSmtp();
    store.setReport({ enabled: true, frequency: 'daily', hour: 6, recipients: ['noc@example.com'] });
    const h = harness();

    now = SUNDAY; // 12:00 UTC — not the 06:00 hour
    await h.service.tickNow();
    expect(h.sendImpl).not.toHaveBeenCalled();

    now = MONDAY_6AM;
    await h.service.tickNow();
    expect(h.sendImpl).toHaveBeenCalledTimes(1);
    expect(store.report().lastResult).toBe('sent');

    // Same scheduled hour again: the 20h min-gap says no.
    await h.service.tickNow();
    expect(h.sendImpl).toHaveBeenCalledTimes(1);

    // Next morning: due again.
    now = MONDAY_6AM + DAY;
    await h.service.tickNow();
    expect(h.sendImpl).toHaveBeenCalledTimes(2);
  });

  it('a disabled schedule never fires on the clock, but force sends anyway', async () => {
    demo = false;
    configureSmtp();
    store.setReport({ enabled: false, recipients: ['noc@example.com'] });
    const h = harness();

    now = MONDAY_6AM;
    await h.service.tickNow();
    expect(h.sendImpl).not.toHaveBeenCalled();

    const result = await h.service.sendReportNow();
    expect(result.ok).toBe(true);
    expect(result.emailed).toBe(true);
    expect(h.sendImpl).toHaveBeenCalledTimes(1);
    expect(h.sent[0]!.mail.to).toEqual(['noc@example.com']);
    expect(h.sent[0]!.mail.subject).toBe('Fleet Summary Report — 2026-08-03');
  });
});

describe('honest outcomes', () => {
  it('demo mode renders into the outbox and never calls the sender', async () => {
    demo = true;
    configureSmtp();
    store.setReport({ enabled: true, recipients: ['noc@example.com'] });
    const h = harness();

    const result = await h.service.sendReportNow();
    expect(result).toMatchObject({ ok: true, demo: true });
    expect(h.sendImpl).not.toHaveBeenCalled();
    expect(h.service.outbox()).toHaveLength(1);
    expect(h.service.outbox()[0]).toMatchObject({ subject: 'Fleet Summary Report — 2026-08-02', demo: true });
    expect(h.service.outbox()[0]!.text).toContain('switch');
    expect(store.report().lastResult).toBe('demo');
    expect(auditEvents().some((e) => e.event === 'notification-report-demo')).toBe(true);
  });

  it('live without SMTP records skipped — never a send, never "sent"', async () => {
    demo = false;
    store.setReport({ enabled: true, recipients: ['noc@example.com'] });
    const h = harness();

    const result = await h.service.sendReportNow();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('SMTP is not configured');
    expect(h.sendImpl).not.toHaveBeenCalled();
    const config = store.report();
    expect(config.lastResult).toBe('skipped');
    expect(config.lastError).toBe('SMTP is not configured');
    expect(config.lastSentAt).toBeUndefined();
    expect(config.lastAttemptAt).toBeDefined();
    expect(auditEvents().some((e) => e.event === 'notification-report-skipped')).toBe(true);
  });

  it('live without recipients says so instead of sending', async () => {
    demo = false;
    configureSmtp();
    store.setReport({ enabled: true, recipients: [] });
    const h = harness();

    const result = await h.service.sendReportNow();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no recipients');
    expect(h.sendImpl).not.toHaveBeenCalled();
    expect(store.report().lastResult).toBe('skipped');
  });

  it('a failed send records the error verbatim and keeps lastSentAt clean', async () => {
    demo = false;
    configureSmtp();
    store.setReport({ enabled: true, recipients: ['noc@example.com'] });
    const h = harness();
    h.sendImpl.mockRejectedValue(new Error('AUTH LOGIN refused — 535 authentication failed'));

    const result = await h.service.sendReportNow();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('535');
    const config = store.report();
    expect(config.lastResult).toBe('failed');
    expect(config.lastError).toContain('535');
    expect(config.lastSentAt).toBeUndefined();
    expect(auditEvents().some((e) => e.event === 'notification-report-failed')).toBe(true);
  });

  it('a successful send stamps lastSentAt and clears any previous error', async () => {
    demo = false;
    configureSmtp();
    store.setReport({ enabled: true, recipients: ['noc@example.com'] });
    const h = harness();
    h.sendImpl.mockRejectedValueOnce(new Error('boom'));
    await h.service.sendReportNow();
    expect(store.report().lastResult).toBe('failed');

    const result = await h.service.sendReportNow();
    expect(result).toMatchObject({ ok: true, emailed: true });
    const config = store.report();
    expect(config.lastResult).toBe('sent');
    expect(config.lastSentAt).toBe(new Date(SUNDAY).toISOString());
    expect(config.lastError).toBeUndefined();
  });

  it('the test email honours demo and reports live delivery honestly', async () => {
    demo = true;
    configureSmtp();
    const h = harness();
    const demoResult = await h.service.testSmtp();
    expect(demoResult).toMatchObject({ ok: true, demo: true });
    expect(h.sendImpl).not.toHaveBeenCalled();
    expect(h.service.outbox()[0]!.subject).toBe('HPE Network Tools — SMTP test');

    demo = false;
    const liveResult = await h.service.testSmtp('noc@example.com');
    expect(liveResult).toMatchObject({ ok: true, emailed: true });
    expect(h.sent[0]!.mail.to).toEqual(['noc@example.com']);
    expect(liveResult.message).toContain('smtp.example.com:587');
  });

  it('testSmtp without a config says so instead of dialling nowhere', async () => {
    demo = false;
    const h = harness();
    const result = await h.service.testSmtp();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not configured');
  });
});

describe('the preview', () => {
  it('renders fleet totals, bell counts, expiring subscriptions and data-gap notes', async () => {
    const h = harness({
      devices: [
        { name: 'sw-1', type: 'switch', state: 'up', siteName: 'Campus' },
        { name: 'sw-2', type: 'switch', state: 'down', siteName: 'Campus' },
      ],
      subscriptions: {
        rows: [{ id: 'sub|SKU|Foundation AP', name: 'Foundation AP', detail: 'SKU', expiresAtMs: SUNDAY + 40 * DAY }],
        unparsed: 1,
        demo: true,
      },
      alerts: [{ createdAt: new Date(SUNDAY - 3_600_000).toISOString(), severity: 'danger' }],
    });
    const report = await h.service.buildPreview();
    expect(report.subject).toBe('Fleet Summary Report — 2026-08-02');
    expect(report.demo).toBe(true);
    expect(report.totalDevices).toBe(2);
    expect(report.totalOffline).toBe(1);
    expect(report.offline[0]!.name).toBe('sw-2');
    expect(report.alerts24h).toBe(1);
    expect(report.expiring).toHaveLength(1);
    expect(report.expiring[0]!.daysLeft).toBe(40);
    expect(report.notes.some((n) => n.includes('no readable expiry date'))).toBe(true);
  });

  it('says the alert counts are a floor when the bell is full', async () => {
    // notificationCenter.add keeps the newest NOTIFICATION_CENTER_CAPACITY
    // entries and drops the rest on write, so a full store hands the report a
    // floor. 'last 168h: 200' otherwise reads as the week's alert count when
    // it is only as much of the week as the bell still holds.
    const h = harness({
      alerts: Array.from({ length: NOTIFICATION_CENTER_CAPACITY }, (_, i) => ({
        createdAt: new Date(SUNDAY - (i + 1) * 60_000).toISOString(),
        severity: 'info',
      })),
    });
    const report = await h.service.buildPreview();
    expect(report.alerts24h).toBe(NOTIFICATION_CENTER_CAPACITY);
    expect(report.notes.some((n) => n.includes('notification center is full'))).toBe(true);
    expect(report.notes.some((n) => n.includes('a floor'))).toBe(true);
    expect(report.text).toContain('DATA GAPS');
  });

  it('does not caveat a bell with room left in it', async () => {
    const h = harness({
      alerts: Array.from({ length: NOTIFICATION_CENTER_CAPACITY - 1 }, (_, i) => ({
        createdAt: new Date(SUNDAY - (i + 1) * 60_000).toISOString(),
        severity: 'info',
      })),
    });
    const report = await h.service.buildPreview();
    expect(report.notes.some((n) => n.includes('notification center is full'))).toBe(false);
  });
});

describe('the expiry ladder', () => {
  const sub = (daysLeft: number, name = 'Foundation AP') => ({
    rows: [{ id: `sub|SKU|${name}`, name, detail: 'SKU', expiresAtMs: now + daysLeft * DAY }],
    unparsed: 0,
    demo: false,
  });

  it('a subscription crossing a threshold pushes one bell entry — once', async () => {
    demo = false;
    const h = harness({ subscriptions: sub(45) });
    await h.service.tickNow();
    const entries = center.list().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: 'Foundation AP — expires in 45d', severity: 'info', url: '/licenses' });
    expect(entries[0]!.body).toContain('60d threshold');

    // A second tick at the same instant: no duplicate.
    await h.service.tickNow();
    expect(center.list().entries).toHaveLength(1);

    // 20 days later: 25 days left — the 30 band fires.
    now = SUNDAY + 20 * DAY;
    h.subscriptions = sub(25);
    await h.service.tickNow();
    expect(center.list().entries).toHaveLength(2);
    expect(center.list().entries[0]).toMatchObject({ title: 'Foundation AP — expires in 25d', severity: 'warning' });
    expect(auditEvents().filter((e) => e.event === 'expiry-notice')).toHaveLength(2);
  });

  it('a renewal re-arms under its new event key', async () => {
    demo = false;
    const h = harness({ subscriptions: sub(45) });
    await h.service.tickNow();
    expect(center.list().entries).toHaveLength(1);

    // Renewed 400 days out: the old event is done.
    h.subscriptions = sub(400);
    await h.service.tickNow();
    expect(center.list().entries).toHaveLength(1);
    expect(store.expiryLadderState()).toEqual({});

    // 320 days on, the RENEWAL itself enters at 80 days and fires at 90.
    now = SUNDAY + 320 * DAY;
    h.subscriptions = sub(80);
    await h.service.tickNow();
    expect(center.list().entries).toHaveLength(2);
    expect(center.list().entries[0]!.title).toContain('expires in 80d');
  });

  it('demo mode adds the labelled demo certificate with a stable event key', async () => {
    demo = true;
    const h = harness();
    await h.service.tickNow();
    const cert = center.list().entries.find((e) => e.title.includes('portal.demo.local'));
    expect(cert).toBeDefined();
    expect(cert!.demo).toBe(true);
    expect(cert!.title).toContain('expires in 21d');

    // The stamped date is stable: a second tick is not a new event.
    await h.service.tickNow();
    expect(center.list().entries.filter((e) => e.title.includes('portal.demo.local'))).toHaveLength(1);
  });

  it('SSL hosts enter the ladder from good probes; failures are recorded and skipped', async () => {
    demo = false;
    store.addSslHost({ host: 'vpn.example.com', port: 443 });
    store.addSslHost({ host: 'dead.example.com', port: 443 });
    const h = harness({
      probeImpl: async (host) => {
        h.probes.push({ host, port: 443 });
        if (host === 'dead.example.com') return { ok: false, error: 'connect ECONNREFUSED 10.0.0.1:443' };
        return { ok: true, notAfter: new Date(now + 20 * DAY).toISOString() };
      },
    });
    await h.service.tickNow();

    const hosts = store.sslHosts();
    const good = hosts.find((x) => x.host === 'vpn.example.com')!;
    expect(good.lastProbe).toMatchObject({ ok: true, daysLeft: 20 });
    const dead = hosts.find((x) => x.host === 'dead.example.com')!;
    expect(dead.lastProbe).toMatchObject({ ok: false, error: 'connect ECONNREFUSED 10.0.0.1:443' });

    const certEntry = center.list().entries.find((e) => e.title.includes('vpn.example.com'));
    expect(certEntry).toBeDefined();
    expect(certEntry!.title).toContain('expires in 20d');
    expect(certEntry!.severity).toBe('warning'); // the 30 band
    expect(center.list().entries.some((e) => e.title.includes('dead.example.com'))).toBe(false);
  });

  it('probes respect the 6h cadence and the probe-now button overrides it', async () => {
    demo = false;
    const added = store.addSslHost({ host: 'vpn.example.com', port: 443 });
    const h = harness();
    await h.service.tickNow();
    expect(h.probes).toHaveLength(1);

    // Same tick again: probed too recently.
    await h.service.tickNow();
    expect(h.probes).toHaveLength(1);

    // The operator's button overrides the cadence.
    const result = await h.service.probeHostNow(added.id);
    expect(result).toHaveProperty('host');
    expect(h.probes).toHaveLength(2);

    // Unknown id is null (the route 404s).
    expect(await h.service.probeHostNow('ssl-nope')).toBeNull();
  });

  it('demo mode answers probe-now honestly instead of dialling', async () => {
    demo = true;
    const added = store.addSslHost({ host: 'vpn.example.com', port: 443 });
    const h = harness();
    const result = await h.service.probeHostNow(added.id);
    expect(result).toHaveProperty('demo', true);
    expect(h.probes).toHaveLength(0);
  });
});
