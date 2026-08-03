/**
 * server/tests/maintenanceWindows.test.ts — the shared window logic.
 *
 * Pure, no I/O: once/weekly spans (boundaries, overnight, time zones,
 * next-span), the window→silence matcher mapping, window/alert matching,
 * and the demo fixtures' own sanity (the showcase the rest of the feature
 * relies on). All times are pinned to fixed instants; the zone-sensitive
 * weekly cases name an explicit IANA zone so the host's zone is irrelevant.
 */

import { describe, expect, it } from 'vitest';
import {
  DEMO_MAINTENANCE_WINDOWS,
  DEMO_TIMELINE_FINGERPRINT,
  alertFingerprint,
  demoAlertTimeline,
  isValidTimeZone,
  maintenanceSiteMatches,
  parseTimeHHMM,
  windowMatchesAlert,
  windowSpanAt,
  windowToSilenceMatcher,
  type AlertRow,
  type MaintenanceWindow,
} from '@hpe/shared';

const once = (start: string, end: string): Pick<MaintenanceWindow, 'schedule'> => ({
  schedule: { kind: 'once', start, end },
});

const weekly = (
  days: number[],
  startTime: string,
  endTime: string,
  tz?: string,
): Pick<MaintenanceWindow, 'schedule'> => ({
  schedule: { kind: 'weekly', days, startTime, endTime, ...(tz ? { tz } : {}) },
});

describe('parseTimeHHMM', () => {
  it('parses strict 24-hour HH:MM and refuses everything else', () => {
    expect(parseTimeHHMM('00:00')).toBe(0);
    expect(parseTimeHHMM('02:30')).toBe(150);
    expect(parseTimeHHMM('23:59')).toBe(1439);
    expect(parseTimeHHMM('24:00')).toBeNull();
    expect(parseTimeHHMM('2:00')).toBeNull();
    expect(parseTimeHHMM('12:60')).toBeNull();
    expect(parseTimeHHMM('noon')).toBeNull();
  });
});

describe('windowSpanAt — once', () => {
  const w = once('2026-08-03T02:00:00.000Z', '2026-08-03T04:00:00.000Z');

  it('is upcoming before the start, with the span known', () => {
    const at = windowSpanAt(w, Date.parse('2026-08-03T01:59:59.000Z'));
    expect(at.state).toBe('upcoming');
    if (at.state !== 'expired') {
      expect(at.span.start).toBe(Date.parse('2026-08-03T02:00:00.000Z'));
      expect(at.span.end).toBe(Date.parse('2026-08-03T04:00:00.000Z'));
    }
  });

  it('is active on the start boundary and until the end boundary', () => {
    expect(windowSpanAt(w, Date.parse('2026-08-03T02:00:00.000Z')).state).toBe('active');
    expect(windowSpanAt(w, Date.parse('2026-08-03T03:59:59.000Z')).state).toBe('active');
  });

  it('is expired at the end boundary — [start, end), never inclusive', () => {
    expect(windowSpanAt(w, Date.parse('2026-08-03T04:00:00.000Z')).state).toBe('expired');
    expect(windowSpanAt(w, Date.parse('2026-08-04T04:00:00.000Z')).state).toBe('expired');
  });

  it('treats an inverted or unparseable span as expired — it can do nothing', () => {
    expect(windowSpanAt(once('2026-08-03T04:00:00.000Z', '2026-08-03T02:00:00.000Z'), Date.parse('2026-08-03T03:00:00.000Z')).state).toBe('expired');
    expect(windowSpanAt(once('soon', 'later'), 0).state).toBe('expired');
  });
});

describe('windowSpanAt — weekly', () => {
  // 2026-08-04 is a Tuesday.
  const tuesday0300 = Date.parse('2026-08-04T03:00:00.000Z');

  it('is active inside a same-day span, in UTC-anchored wall time', () => {
    const w = weekly([2], '02:00', '04:00', 'UTC');
    const at = windowSpanAt(w, tuesday0300);
    expect(at.state).toBe('active');
    if (at.state === 'active') {
      expect(at.span.start).toBe(Date.parse('2026-08-04T02:00:00.000Z'));
      expect(at.span.end).toBe(Date.parse('2026-08-04T04:00:00.000Z'));
    }
  });

  it('names the next span when today is not one of the days', () => {
    const w = weekly([6], '02:00', '04:00', 'UTC'); // Saturdays
    const at = windowSpanAt(w, tuesday0300); // Tuesday → next is Saturday 2026-08-08
    expect(at.state).toBe('upcoming');
    if (at.state !== 'expired') {
      expect(at.span.start).toBe(Date.parse('2026-08-08T02:00:00.000Z'));
      expect(at.span.end).toBe(Date.parse('2026-08-08T04:00:00.000Z'));
    }
  });

  it('names the next span later the same day when the span has not started', () => {
    const w = weekly([2], '05:00', '06:00', 'UTC');
    const at = windowSpanAt(w, tuesday0300);
    expect(at.state).toBe('upcoming');
    if (at.state !== 'expired') expect(at.span.start).toBe(Date.parse('2026-08-04T05:00:00.000Z'));
  });

  it('skips a span that already ended today and finds next week’s', () => {
    const w = weekly([2], '00:00', '02:00', 'UTC');
    const at = windowSpanAt(w, tuesday0300); // today's 00:00–02:00 is over
    expect(at.state).toBe('upcoming');
    if (at.state !== 'expired') expect(at.span.start).toBe(Date.parse('2026-08-11T00:00:00.000Z'));
  });

  it('an overnight span ending today is still active after midnight', () => {
    const w = weekly([1], '22:00', '02:00', 'UTC'); // Mondays 22:00 → Tuesdays 02:00
    const at = windowSpanAt(w, Date.parse('2026-08-04T01:30:00.000Z')); // Tuesday 01:30
    expect(at.state).toBe('active');
    if (at.state === 'active') {
      expect(at.span.start).toBe(Date.parse('2026-08-03T22:00:00.000Z'));
      expect(at.span.end).toBe(Date.parse('2026-08-04T02:00:00.000Z'));
    }
  });

  it('an overnight span starts on its named day, not before', () => {
    const w = weekly([1], '22:00', '02:00', 'UTC');
    const at = windowSpanAt(w, Date.parse('2026-08-03T21:00:00.000Z')); // Monday 21:00
    expect(at.state).toBe('upcoming');
    if (at.state !== 'expired') expect(at.span.start).toBe(Date.parse('2026-08-03T22:00:00.000Z'));
  });

  it('honors the named zone — 02:00 in Berlin is 00:00Z in summer', () => {
    const w = weekly([2], '02:00', '04:00', 'Europe/Berlin'); // CEST = UTC+2
    const at = windowSpanAt(w, Date.parse('2026-08-04T01:00:00.000Z')); // 03:00 Berlin
    expect(at.state).toBe('active');
    if (at.state === 'active') {
      expect(at.span.start).toBe(Date.parse('2026-08-04T00:00:00.000Z'));
      expect(at.span.end).toBe(Date.parse('2026-08-04T02:00:00.000Z'));
    }
  });

  it('a window covering every day all day is always active (the demo fixture shape)', () => {
    const w = weekly([0, 1, 2, 3, 4, 5, 6], '00:00', '23:59', 'UTC');
    expect(windowSpanAt(w, tuesday0300).state).toBe('active');
    expect(windowSpanAt(w, Date.parse('2026-08-09T12:00:00.000Z')).state).toBe('active'); // Sunday
  });

  it('refuses the uncomputable: equal times, bad times, no days', () => {
    expect(windowSpanAt(weekly([2], '02:00', '02:00', 'UTC'), tuesday0300).state).toBe('expired');
    expect(windowSpanAt(weekly([2], 'two', 'four', 'UTC'), tuesday0300).state).toBe('expired');
    expect(windowSpanAt(weekly([], '02:00', '04:00', 'UTC'), tuesday0300).state).toBe('expired');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and refuses garbage', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('windowToSilenceMatcher', () => {
  it('maps titleSubstring to titleContains and carries site through', () => {
    expect(
      windowToSilenceMatcher({
        matchers: { plane: ' MIST ', device: 'ap-3f-12', site: 'Campus-02 Research', titleSubstring: 'firmware' },
      }),
    ).toEqual({ plane: 'MIST', device: 'ap-3f-12', site: 'Campus-02 Research', titleContains: 'firmware' });
  });

  it('drops blank matchers rather than emitting empty criteria', () => {
    expect(windowToSilenceMatcher({ matchers: { device: 'ap-1', site: '  ' } })).toEqual({ device: 'ap-1' });
  });
});

describe('windowMatchesAlert', () => {
  const alert: Pick<AlertRow, 'plane' | 'device' | 'title' | 'siteId' | 'siteName'> = {
    plane: 'MIST',
    device: 'ap-3f-12',
    title: 'Wi-Fi drops, 3rd floor east — 22 clients',
    siteId: 'campus-02',
    siteName: 'Campus-02 Research',
  };

  it('ANDs every set matcher, case-insensitively', () => {
    expect(windowMatchesAlert({ matchers: { device: 'AP-3F-12', titleSubstring: 'wi-fi drops' } }, alert)).toBe(true);
    expect(windowMatchesAlert({ matchers: { device: 'ap-3f-12', plane: 'CENTRAL' } }, alert)).toBe(false);
    expect(windowMatchesAlert({ matchers: { titleSubstring: 'firmware' } }, alert)).toBe(false);
  });

  it('matches site against siteName OR siteId', () => {
    expect(windowMatchesAlert({ matchers: { site: 'campus-02 research' } }, alert)).toBe(true);
    expect(windowMatchesAlert({ matchers: { site: 'campus-02' } }, alert)).toBe(true);
    expect(windowMatchesAlert({ matchers: { site: 'riverside' } }, alert)).toBe(false);
    expect(maintenanceSiteMatches('Campus-02 Research', alert)).toBe(true);
  });

  it('a matcher-less window matches nothing — the second line of defence', () => {
    expect(windowMatchesAlert({ matchers: {} }, alert)).toBe(false);
  });
});

describe('the demo fixtures', () => {
  it('the AP fixture window is always inside a span and covers the flapping AP', () => {
    const apWindow = DEMO_MAINTENANCE_WINDOWS.find((w) => w.id === 'mw-demo-ap3f');
    expect(apWindow).toBeDefined();
    expect(windowSpanAt(apWindow!, Date.now()).state).toBe('active');
    expect(
      windowMatchesAlert(apWindow!, {
        plane: 'MIST',
        device: 'ap-3f-12',
        title: 'Wi-Fi drops, 3rd floor east — 22 clients',
        siteId: 'campus-02',
        siteName: 'Campus-02 Research',
      }),
    ).toBe(true);
  });

  it('the firmware fixture window is the Saturday 02:00–04:00 one the demo queue names', () => {
    const fw = DEMO_MAINTENANCE_WINDOWS.find((w) => w.id === 'mw-demo-firmware');
    expect(fw).toBeDefined();
    const at = windowSpanAt(fw!, Date.parse('2026-08-04T03:00:00.000Z')); // a Tuesday
    expect(at.state).toBe('upcoming');
    if (at.state !== 'expired') expect(new Date(at.span.start).getUTCDay()).toBe(6);
  });

  it('the authored timeline belongs to the flapping-AP fingerprint and is ordered', () => {
    const fp = alertFingerprint({ plane: 'MIST', device: 'ap-3f-12', title: 'Wi-Fi drops, 3rd floor east — 22 clients' });
    expect(fp).toBe(DEMO_TIMELINE_FINGERPRINT);
    const fixture = demoAlertTimeline(fp, Date.parse('2026-08-01T12:00:00.000Z'));
    expect(fixture).not.toBeNull();
    expect(fixture!.events.map((e) => e.kind)).toEqual(['change', 'fired', 'fired', 'silenced', 'config-drift']);
    expect(fixture!.correlation).toContain('within 30m after change');
    expect(fixture!.correlation).toContain('not a proven cause');
    expect(demoAlertTimeline('some|other|fingerprint')).toBeNull();
  });
});
