/**
 * server/tests/expiryShared.test.ts — the pure half of the email channel:
 * shared/expiry.ts.
 *
 * Covered:
 *   ladder   — the band is the TIGHTEST threshold ≥ days-left, nothing
 *              matches beyond 90d, an expired item sits in the 15 band;
 *              the event key names the EVENT ('{id}@{expiryDate}') so a
 *              renewal re-arms; first sight notifies once at its tightest
 *              band, the same band never re-notifies, a tighter band does;
 *              departed items are pruned from the state;
 *   gate     — reportDue: disabled, the scheduled occurrence (UTC hour,
 *              Monday for weekly), one fire per occurrence (sent OR
 *              attempted), catching up a late occurrence, refusing one that
 *              is too far behind, and force bypassing the clock;
 *   content  — buildFleetReport: per-type totals, offline cap 25 + '+N
 *              more', bell counts at 24h/168h, subscriptions ≤90d capped 15,
 *              the UTC-dated subject, data-gap notes;
 *   helpers  — parseShortExpiryDate, isOfflineState, isEmailAddress,
 *              validateSmtpConfig, validateReportConfig, parseSslTarget.
 *
 * Everything is pinned to fixed UTC instants; TZ=UTC makes it exact.
 */

import { describe, expect, it } from 'vitest';
import {
  EXPIRY_THRESHOLDS,
  REPORT_CATCHUP_MAX_MS,
  lastScheduledOccurrence,
  buildFleetReport,
  daysUntilExpiry,
  evaluateExpiryLadder,
  expiryBand,
  expiryEventKey,
  fleetReportSubject,
  isEmailAddress,
  isOfflineState,
  parseShortExpiryDate,
  parseSslTarget,
  reportDue,
  validateReportConfig,
  validateSmtpConfig,
  type ExpiringItem,
  type ReportConfig,
} from '@hpe/shared';

const DAY = 86_400_000;
/** 2026-08-02 12:00 UTC — a Sunday. */
const SUNDAY = Date.UTC(2026, 7, 2, 12, 0, 0);
/** 2026-08-03 06:00 UTC — a Monday, at the default scheduled hour. */
const MONDAY_6AM = Date.UTC(2026, 7, 3, 6, 0, 0);

const item = (over: Partial<ExpiringItem> = {}): ExpiringItem => ({
  id: 'sub|SKU-1|Foundation AP',
  kind: 'subscription',
  name: 'Foundation AP',
  expiresAtMs: SUNDAY + 45 * DAY,
  ...over,
});

describe('expiryBand', () => {
  it('is the tightest threshold ≥ days-left', () => {
    expect(expiryBand(90)).toBe(90);
    expect(expiryBand(45)).toBe(60);
    expect(expiryBand(16)).toBe(30);
    expect(expiryBand(15)).toBe(15);
    expect(expiryBand(1)).toBe(15);
  });

  it('matches nothing beyond the widest gate, and an expired item sits tightest', () => {
    expect(expiryBand(91)).toBeNull();
    expect(expiryBand(365)).toBeNull();
    expect(expiryBand(0)).toBe(15);
    expect(expiryBand(-4)).toBe(15);
  });

  it('declares the thresholds the spec ports: 90, 60, 30, 15', () => {
    expect([...EXPIRY_THRESHOLDS]).toEqual([90, 60, 30, 15]);
  });
});

describe('expiryEventKey + daysUntilExpiry', () => {
  it('the key names the event — id at the expiry date — so a renewal re-arms', () => {
    const before = item();
    const renewed = item({ expiresAtMs: SUNDAY + 400 * DAY });
    expect(expiryEventKey(before)).toBe('sub|SKU-1|Foundation AP@2026-09-16');
    expect(expiryEventKey(renewed)).not.toBe(expiryEventKey(before));
    // Same thing, same expiry: identical key (the dedup anchor).
    expect(expiryEventKey(item())).toBe(expiryEventKey(item()));
  });

  it('days-left floors — 89.9 days reads 89', () => {
    expect(daysUntilExpiry(SUNDAY + 89 * DAY + 23 * 3_600_000, SUNDAY)).toBe(89);
    expect(daysUntilExpiry(SUNDAY, SUNDAY)).toBe(0);
    expect(daysUntilExpiry(SUNDAY - 1, SUNDAY)).toBe(-1);
  });
});

describe('evaluateExpiryLadder', () => {
  it('first sight notifies once at the tightest band — not once per passed gate', () => {
    const { notices, state } = evaluateExpiryLadder([item()], {}, SUNDAY);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.band).toBe(60);
    expect(notices[0]!.daysLeft).toBe(45);
    expect(state[expiryEventKey(item())]).toBe(60);
  });

  it('the same band never re-notifies; a tighter band does', () => {
    const first = evaluateExpiryLadder([item()], {}, SUNDAY);
    // Same instant again: nothing new.
    expect(evaluateExpiryLadder([item()], first.state, SUNDAY).notices).toHaveLength(0);
    // 20 days later: 25 days left → the 30 band.
    const later = evaluateExpiryLadder([item()], first.state, SUNDAY + 20 * DAY);
    expect(later.notices).toHaveLength(1);
    expect(later.notices[0]!.band).toBe(30);
    // And the 15 band eventually — but never 60/30 again.
    const last = evaluateExpiryLadder([item()], later.state, SUNDAY + 35 * DAY);
    expect(last.notices).toHaveLength(1);
    expect(last.notices[0]!.band).toBe(15);
    expect(evaluateExpiryLadder([item()], last.state, SUNDAY + 40 * DAY).notices).toHaveLength(0);
  });

  it('an item sighted already tight notifies once at that band', () => {
    const { notices } = evaluateExpiryLadder([item({ expiresAtMs: SUNDAY + 10 * DAY })], {}, SUNDAY);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.band).toBe(15);
  });

  it('a renewal re-arms the whole ladder under its new event key', () => {
    const first = evaluateExpiryLadder([item()], {}, SUNDAY);
    const renewed = item({ expiresAtMs: SUNDAY + 400 * DAY });
    // 400 days out: beyond the widest gate — no notice, and the old key is pruned.
    const renewedFar = evaluateExpiryLadder([renewed], first.state, SUNDAY);
    expect(renewedFar.notices).toHaveLength(0);
    expect(Object.keys(renewedFar.state)).toHaveLength(0);
    // 320 days later the renewal itself walks in at 80 days → the 90 band fires again.
    const backOn = evaluateExpiryLadder([renewed], renewedFar.state, SUNDAY + 320 * DAY);
    expect(backOn.notices).toHaveLength(1);
    expect(backOn.notices[0]!.band).toBe(90);
  });

  it('items beyond the ladder produce nothing and record nothing', () => {
    const { notices, state } = evaluateExpiryLadder([item({ expiresAtMs: SUNDAY + 91 * DAY })], {}, SUNDAY);
    expect(notices).toHaveLength(0);
    expect(state).toEqual({});
  });

  it('prunes state for events whose items departed', () => {
    const first = evaluateExpiryLadder([item()], {}, SUNDAY);
    const { state } = evaluateExpiryLadder([], first.state, SUNDAY + DAY);
    expect(state).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The report gate
// ---------------------------------------------------------------------------

const config = (over: Partial<ReportConfig> = {}): ReportConfig => ({
  enabled: true,
  frequency: 'daily',
  hour: 6,
  recipients: ['noc@example.com'],
  ...over,
});

describe('reportDue', () => {
  it('a disabled schedule never fires', () => {
    const check = reportDue(config({ enabled: false }), MONDAY_6AM);
    expect(check.due).toBe(false);
    expect(check.reason).toContain('disabled');
  });

  it('fires at the scheduled hour, and still fires after it', () => {
    expect(reportDue(config(), MONDAY_6AM).due).toBe(true);
    // An hour late is still the same report. The old gate demanded an exact
    // hour match, so this was the moment a day's report became unsendable.
    // Catch-up needs a prior fire to anchor to — see the never-fired case.
    const established = config({ lastSentAt: new Date(MONDAY_6AM - DAY + 60_000).toISOString() });
    const late = reportDue(established, MONDAY_6AM + 3_600_000);
    expect(late.due).toBe(true);
    expect(late.reason).toContain('late');
    // Before the hour comes round, the day's occurrence has not arrived.
    expect(reportDue(config(), MONDAY_6AM - 3_600_000).due).toBe(false);
    // A different configured hour: 23 is the slot, not 6.
    expect(reportDue(config({ hour: 23 }), MONDAY_6AM + 17 * 3_600_000).due).toBe(true);
  });

  it('a laptop asleep through the scheduled hour still gets its report', () => {
    // 06:00 UTC is 01:00 where the operator lives. The machine is shut. It
    // opens at 08:00 UTC and the day's report should be waiting, labelled.
    const established = config({ lastSentAt: new Date(MONDAY_6AM - DAY + 60_000).toISOString() });
    const woke = reportDue(established, MONDAY_6AM + 2 * 3_600_000);
    expect(woke.due).toBe(true);
    expect(woke.reason).toContain('2h late');
    expect(woke.missedOccurrence).toBeUndefined();
  });

  it('too far behind is refused as that report, and says so instead of going quiet', () => {
    const staleBy = REPORT_CATCHUP_MAX_MS.daily + 3_600_000;
    const established = config({ lastSentAt: new Date(MONDAY_6AM - DAY + 60_000).toISOString() });
    const check = reportDue(established, MONDAY_6AM + staleBy);
    expect(check.due).toBe(false);
    expect(check.reason).toContain('did not go out');
    expect(check.missedOccurrence).toBe(new Date(MONDAY_6AM).toISOString());
  });

  it('one fire per occurrence — a restart inside the hour cannot send twice', () => {
    const sent = config({ lastSentAt: new Date(MONDAY_6AM + 60_000).toISOString() });
    for (const minutes of [2, 30, 59]) {
      const check = reportDue(sent, MONDAY_6AM + minutes * 60_000);
      expect(check.due).toBe(false);
      expect(check.reason).toContain('already been handled');
    }
    // ...and the next day's occurrence is a different one, so it fires. A
    // 20h elapsed-time gap would have been fine here but not after a late
    // catch-up, which is why the gate counts occurrences instead.
    expect(reportDue(sent, MONDAY_6AM + DAY).due).toBe(true);
  });

  it('a late catch-up does not swallow the next occurrence', () => {
    // Sent 11h late (17:00). Tomorrow 06:00 is only 13h after that — inside
    // the old 20h minimum gap, which would have skipped the day entirely.
    const lateFire = config({ lastSentAt: new Date(MONDAY_6AM + 11 * 3_600_000).toISOString() });
    expect(reportDue(lateFire, MONDAY_6AM + DAY).due).toBe(true);
  });

  it('lastScheduledOccurrence walks back to the slot, and to Monday for weekly', () => {
    expect(lastScheduledOccurrence({ frequency: 'daily', hour: 6 }, MONDAY_6AM + 3_600_000)).toBe(MONDAY_6AM);
    // Before today's slot, the most recent one is yesterday's.
    expect(lastScheduledOccurrence({ frequency: 'daily', hour: 6 }, MONDAY_6AM - 60_000)).toBe(MONDAY_6AM - DAY);
    // Weekly from a Thursday still points at Monday's slot.
    const thursday = lastScheduledOccurrence({ frequency: 'weekly', hour: 6 }, MONDAY_6AM + 3 * DAY);
    expect(thursday).toBe(MONDAY_6AM);
    expect(new Date(thursday).getUTCDay()).toBe(1);
  });

  it('weekly fires on Mondays only', () => {
    const weekly = config({ frequency: 'weekly' });
    expect(reportDue(weekly, MONDAY_6AM).due).toBe(true);
    // Same hour on a Sunday is not the slot. For a schedule that has been
    // running, Monday's report is already handled and the next is Monday.
    const running = config({ frequency: 'weekly', lastSentAt: new Date(MONDAY_6AM + 60_000).toISOString() });
    const sunday = reportDue(running, SUNDAY + 5 * DAY);
    expect(sunday.due).toBe(false);
    expect(sunday.reason).toContain('Monday');
    // Ran two Mondays back, then the machine was away for the next one: the
    // dropped Monday is named rather than passed over in silence.
    const ranTwoWeeksBack = config({ frequency: 'weekly', lastSentAt: new Date(MONDAY_6AM - 14 * DAY + 60_000).toISOString() });
    const missed = reportDue(ranTwoWeeksBack, SUNDAY - 6 * 3_600_000);
    expect(missed.due).toBe(false);
    expect(missed.reason).toContain('Monday');
    expect(missed.missedOccurrence).toBeTruthy();
  });

  it('a fire BEFORE an occurrence does not close it — an ad-hoc send is not the schedule', () => {
    // Sent at 04:00, whether by the operator's Send now or as a late catch-up
    // of yesterday's slot. 06:00 is a different occurrence and still owed.
    const sentEarlier = config({ lastSentAt: new Date(MONDAY_6AM - 2 * 3_600_000).toISOString() });
    expect(reportDue(sentEarlier, MONDAY_6AM).due).toBe(true);
    const weeklyLastWeek = config({ frequency: 'weekly', lastSentAt: new Date(MONDAY_6AM - 5 * DAY).toISOString() });
    expect(reportDue(weeklyLastWeek, MONDAY_6AM).due).toBe(true);
  });

  it('a failed attempt does not retry every tick (lastAttemptAt closes the occurrence)', () => {
    // The property that matters: a failure at 06:00 must not re-fire at 06:01,
    // 06:02, ... The attempt stamp sits at/after the occurrence, closing it.
    const failedAtTheHour = config({
      lastSentAt: new Date(MONDAY_6AM - 30 * 3_600_000).toISOString(),
      lastAttemptAt: new Date(MONDAY_6AM + 30_000).toISOString(),
      lastResult: 'failed',
    });
    for (const minutes of [1, 5, 45]) {
      expect(reportDue(failedAtTheHour, MONDAY_6AM + minutes * 60_000).due).toBe(false);
    }
    // Tomorrow is a new occurrence — a failure does not disable the report.
    expect(reportDue(failedAtTheHour, MONDAY_6AM + DAY).due).toBe(true);
  });

  it('the catch-up bounds stay well inside one period, so a catch-up is never the next slot', () => {
    expect(REPORT_CATCHUP_MAX_MS.daily).toBeLessThan(DAY);
    expect(REPORT_CATCHUP_MAX_MS.weekly).toBeLessThan(7 * DAY);
  });

  it('force bypasses the clock and the disabled flag — the operator asked', () => {
    expect(reportDue(config({ enabled: false }), SUNDAY, true).due).toBe(true);
    const justSent = config({ lastSentAt: new Date(MONDAY_6AM).toISOString() });
    expect(reportDue(justSent, MONDAY_6AM + 3_600_000, true).due).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The report content
// ---------------------------------------------------------------------------

describe('buildFleetReport', () => {
  it('the subject is UTC-dated, exactly as specified', () => {
    expect(fleetReportSubject(SUNDAY)).toBe('Fleet Summary Report — 2026-08-02');
  });

  it('totals by device type, offline rows capped at 25 with the overflow stated', () => {
    const devices = [
      ...Array.from({ length: 30 }, (_, i) => ({ name: `sw-${String(i).padStart(2, '0')}`, type: 'switch', state: 'down', siteName: 'Campus' })),
      { name: 'ap-01', type: 'ap', state: 'up', siteName: 'Campus' },
      { name: 'ap-02', type: 'ap', state: 'offline', siteName: 'Campus' },
    ];
    const report = buildFleetReport({ nowMs: SUNDAY, demo: false, devices, alerts: [], subscriptions: [] });
    expect(report.totalDevices).toBe(32);
    expect(report.totalOffline).toBe(31);
    const switches = report.totals.find((t) => t.type === 'switch')!;
    expect(switches).toMatchObject({ total: 30, online: 0, offline: 30 });
    const aps = report.totals.find((t) => t.type === 'ap')!;
    expect(aps).toMatchObject({ total: 2, online: 1, offline: 1 });
    expect(report.offline).toHaveLength(25);
    expect(report.offlineOverflow).toBe(6);
    expect(report.text).toContain('+6 more not listed');
    expect(report.text).toContain('switch');
    expect(report.html).toContain('OFFLINE DEVICES (31');
  });

  it('counts bell entries at 24h and 168h, with a 24h severity breakdown', () => {
    const alerts = [
      { createdAt: new Date(SUNDAY - 2 * 3_600_000).toISOString(), severity: 'danger' },
      { createdAt: new Date(SUNDAY - 20 * 3_600_000).toISOString(), severity: 'warning' },
      { createdAt: new Date(SUNDAY - 100 * 3_600_000).toISOString(), severity: 'info' },
      { createdAt: new Date(SUNDAY - 200 * 3_600_000).toISOString(), severity: 'danger' }, // outside 168h
    ];
    const report = buildFleetReport({ nowMs: SUNDAY, demo: false, devices: [], alerts, subscriptions: [] });
    expect(report.alerts24h).toBe(2);
    expect(report.alerts168h).toBe(3);
    expect(report.alerts24hBySeverity).toEqual({ danger: 1, warning: 1 });
    expect(report.text).toContain('last 24h: 2 (danger 1, warning 1)');
    expect(report.text).toContain('last 168h: 3');
  });

  it('subscriptions ≤90d sorted soonest-first and capped at 15, overflow stated', () => {
    const subscriptions = [
      ...Array.from({ length: 18 }, (_, i) => ({
        id: `sub|SKU-${i}|Sub ${i}`,
        name: `Sub ${String(i).padStart(2, '0')}`,
        expiresAtMs: SUNDAY + (i + 1) * DAY,
      })),
      { id: 'sub|SKU-FAR|Far away', name: 'Far away', expiresAtMs: SUNDAY + 120 * DAY }, // outside the window
      { id: 'sub|SKU-OLD|Expired one', name: 'Expired one', expiresAtMs: SUNDAY - 2 * DAY }, // expired counts
    ];
    const report = buildFleetReport({ nowMs: SUNDAY, demo: false, devices: [], alerts: [], subscriptions });
    expect(report.expiring).toHaveLength(15);
    expect(report.expiringOverflow).toBe(4);
    expect(report.expiring[0]!.name).toBe('Expired one');
    expect(report.expiring[0]!.daysLeft).toBe(-2);
    expect(report.expiring.map((s) => s.name)).not.toContain('Far away');
    expect(report.text).toContain('expired 2d ago');
    expect(report.text).toContain('+4 more not listed');
  });

  it('counts the alerts it could not place in time instead of dropping them', () => {
    // An entry whose createdAt will not parse falls out of BOTH windows. The
    // subscription section already owns up to exactly this ('no readable
    // expiry date'); a report that quietly shrinks its alert count is telling
    // the reader the week was quieter than it was.
    const alerts = [
      { createdAt: new Date(SUNDAY - 2 * 3_600_000).toISOString(), severity: 'danger' },
      { createdAt: 'not a date', severity: 'danger' },
      { createdAt: '', severity: 'warning' },
    ];
    const report = buildFleetReport({ nowMs: SUNDAY, demo: false, devices: [], alerts, subscriptions: [] });
    expect(report.alerts24h).toBe(1);
    expect(report.alerts168h).toBe(1);
    expect(report.alertsUndated).toBe(2);
    expect(report.text).toContain('2 alerts carried no readable timestamp');
    expect(report.text).toContain('not ignored');
    expect(report.html).toContain('2 alerts carried no readable timestamp');
  });

  it('agrees with itself in the singular, and stays silent when every alert parsed', () => {
    const one = buildFleetReport({
      nowMs: SUNDAY,
      demo: false,
      devices: [],
      alerts: [{ createdAt: 'nope', severity: 'info' }],
      subscriptions: [],
    });
    expect(one.text).toContain('1 alert carried no readable timestamp');

    // A caveat that is always on is worth nothing on the day it matters.
    const clean = buildFleetReport({
      nowMs: SUNDAY,
      demo: false,
      devices: [],
      alerts: [{ createdAt: new Date(SUNDAY - 3_600_000).toISOString(), severity: 'info' }],
      subscriptions: [],
    });
    expect(clean.alertsUndated).toBe(0);
    expect(clean.text).not.toContain('no readable timestamp');
    expect(clean.html).not.toContain('no readable timestamp');
  });

  it('data gaps render as notes — never a confident zero', () => {
    const report = buildFleetReport({
      nowMs: SUNDAY,
      demo: true,
      devices: [],
      alerts: [],
      subscriptions: [],
      notes: ['no device data — no plane has reported a device'],
    });
    expect(report.demo).toBe(true);
    expect(report.text).toContain('DATA GAPS');
    expect(report.text).toContain('no device data');
    expect(report.text).toContain('DEMO');
  });
});

// ---------------------------------------------------------------------------
// Helpers + validation
// ---------------------------------------------------------------------------

describe('parseShortExpiryDate', () => {
  it('reads the licence table’s display dates', () => {
    expect(parseShortExpiryDate('14 Sep 26')).toBe(Date.UTC(2026, 8, 14));
    expect(parseShortExpiryDate('02 Mar 28')).toBe(Date.UTC(2028, 2, 2));
    expect(parseShortExpiryDate('30 Nov 2026')).toBe(Date.UTC(2026, 10, 30));
    expect(parseShortExpiryDate('2026-09-14')).toBe(Date.UTC(2026, 8, 14));
    // The support-contract rows carry the same date with a qualifier.
    expect(parseShortExpiryDate('support 31 Jan 27')).toBe(Date.UTC(2027, 0, 31));
  });

  it('returns null for non-dates — the caller says so instead of guessing', () => {
    expect(parseShortExpiryDate('—')).toBeNull();
    expect(parseShortExpiryDate('perpetual')).toBeNull();
    expect(parseShortExpiryDate('')).toBeNull();
    expect(parseShortExpiryDate('14 Foo 26')).toBeNull();
  });
});

describe('isOfflineState', () => {
  it('the planes’ down plus the fixtures’ offline — nothing else', () => {
    expect(isOfflineState('down')).toBe(true);
    expect(isOfflineState('offline')).toBe(true);
    expect(isOfflineState('up')).toBe(false);
    expect(isOfflineState('degraded')).toBe(false);
    expect(isOfflineState('flapping')).toBe(false);
  });
});

describe('isEmailAddress', () => {
  it('exactly one @, something on both sides, no whitespace', () => {
    expect(isEmailAddress('noc@example.com')).toBe(true);
    expect(isEmailAddress('a@b')).toBe(true);
    expect(isEmailAddress('not-an-address')).toBe(false);
    expect(isEmailAddress('a@@b.com')).toBe(false);
    expect(isEmailAddress('a @b.com')).toBe(false);
    expect(isEmailAddress('@b.com')).toBe(false);
    expect(isEmailAddress('a@')).toBe(false);
  });
});

describe('validateSmtpConfig', () => {
  it('requires a hostname (not a URL), a real port, and an email sender', () => {
    expect(validateSmtpConfig({ host: 'smtp.example.com', from: 'reports@example.com', tls: true })).toEqual([]);
    expect(validateSmtpConfig({ host: 'https://smtp.example.com', from: 'reports@example.com', tls: true })[0]).toContain('hostname');
    expect(validateSmtpConfig({ host: '', from: 'reports@example.com', tls: true })[0]).toContain('host is required');
    expect(validateSmtpConfig({ host: 'smtp.example.com', port: 0, from: 'r@example.com', tls: true })[0]).toContain('port');
    expect(validateSmtpConfig({ host: 'smtp.example.com', port: 70000, from: 'r@example.com', tls: true })[0]).toContain('port');
    expect(validateSmtpConfig({ host: 'smtp.example.com', from: 'not-an-address', tls: true })[0]).toContain('from');
  });
});

describe('validateReportConfig', () => {
  it('bounds the hour, knows the two frequencies, and checks every recipient', () => {
    expect(validateReportConfig({ frequency: 'weekly', hour: 6, recipients: ['noc@example.com'] })).toEqual([]);
    expect(validateReportConfig({ frequency: 'hourly' as never, hour: 6, recipients: [] })[0]).toContain('daily or weekly');
    expect(validateReportConfig({ frequency: 'daily', hour: 24, recipients: [] })[0]).toContain('0 and 23');
    expect(validateReportConfig({ frequency: 'daily', hour: -1, recipients: [] })[0]).toContain('0 and 23');
    expect(validateReportConfig({ frequency: 'daily', hour: 6, recipients: ['noc@example.com', 'junk'] })[0]).toContain('junk');
  });
});

describe('parseSslTarget', () => {
  it('parses host[:port], defaulting the port to 443 and lowercasing the host', () => {
    expect(parseSslTarget('vpn.example.com')).toEqual({ host: 'vpn.example.com', port: 443 });
    expect(parseSslTarget('VPN.Example.com:8443')).toEqual({ host: 'vpn.example.com', port: 8443 });
    expect(parseSslTarget('10.0.0.1:443')).toEqual({ host: '10.0.0.1', port: 443 });
  });

  it('refuses junk rather than repairing it', () => {
    expect(parseSslTarget('')).toContain('host is required');
    expect(parseSslTarget('host:notaport')).toContain('host[:port]');
    expect(parseSslTarget('host:70000')).toContain('port');
    expect(parseSslTarget('bad host.com')).toContain('not a hostname');
    expect(parseSslTarget('bad..host.com')).toContain('not a hostname');
    expect(parseSslTarget('-bad.com')).toContain('not a hostname');
  });
});
