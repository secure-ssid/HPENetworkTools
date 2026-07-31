/**
 * server/tests/displayFormat.test.ts — one way of writing a quantity.
 *
 * Every number on this portal used to be written by whichever line of code
 * happened to reach a reader first. Forty-one call sites called
 * `toLocaleString('en-US')`; forty more interpolated the number bare. The two
 * populations were not separated by anything — they were interleaved, tile by
 * tile and clause by clause, so the Auth events row showed `1,204` known
 * endpoints beside `1204` MAB fallbacks, and the Overview wrote
 * `1,234 devices · 5678 calls today` inside a single string.
 *
 * The whole existing suite passed through that defect without noticing,
 * because every fixture in it counts fewer than a thousand of anything and a
 * thousand is exactly where a grouping separator starts to show. So the
 * numbers here are deliberately four figures. A test that cannot tell
 * `formatCount` from `String` is not testing this rule.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { countOf, formatCount, shortDateLocal } from '@hpe/shared';
import type { StatDef } from '@hpe/shared';

// Set before the settings singleton is constructed at import time — the real
// data/settings.json is never touched by the suite.
const tmp = mkdtempSync(join(tmpdir(), 'hpe-display-format-'));
process.env.HPE_SETTINGS_PATH = join(tmp, 'settings.json');
process.env.HPE_DATA_DIR = join(tmp, 'data');

let liveAuthStats: typeof import('../src/routes/screens/authEventsModel').liveAuthStats;
let liveFailReasons: typeof import('../src/routes/screens/authEventsModel').liveFailReasons;
let livePolicyServices: typeof import('../src/routes/screens/authEventsModel').livePolicyServices;
let liveLicenseStats: typeof import('../src/routes/screens/licenseModel').liveLicenseStats;
let liveOverviewPlanes: typeof import('../src/routes/screens/overviewModel').liveOverviewPlanes;
let registry: typeof import('../src/planes/registry').registry;
let settings: typeof import('../src/config/settings').settings;

beforeAll(async () => {
  ({ liveAuthStats, liveFailReasons, livePolicyServices } = await import(
    '../src/routes/screens/authEventsModel'
  ));
  ({ liveLicenseStats } = await import('../src/routes/screens/licenseModel'));
  ({ liveOverviewPlanes } = await import('../src/routes/screens/overviewModel'));
  ({ registry } = await import('../src/planes/registry'));
  ({ settings } = await import('../src/config/settings'));
});

/** Every string a StatDef puts on screen. */
function shown(stats: StatDef[]): string[] {
  return stats.flatMap((s) => [s.value, s.delta ?? '']);
}

/**
 * A four-figure number written without its separator. This is the shape the
 * defect took: not a wrong number, a number written the other way, next to
 * one written the first way.
 */
function ungrouped(text: string, n: number): boolean {
  return new RegExp(`(?<![\\d,])${n}(?![\\d,])`).test(text);
}

describe('formatCount', () => {
  it('groups at the thousand, which is the only place the rule is visible', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1000)).toBe('1,000');
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it('writes zero as zero — a count of none is still a count', () => {
    expect(formatCount(0)).toBe('0');
  });

  it('does not write a non-number as though it were one', () => {
    // 'NaN' in a tile reads as a value the plane reported. '—' is the
    // portal's word for "not known", which is what actually happened.
    expect(formatCount(Number.NaN)).toBe('—');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('countOf', () => {
  it('agrees in number with the noun it counts', () => {
    expect(countOf(1, 'device')).toBe('1 device');
    expect(countOf(0, 'device')).toBe('0 devices');
    expect(countOf(2, 'device')).toBe('2 devices');
  });

  it('takes an explicit plural where English does not just add an s', () => {
    expect(countOf(1, 'entry', 'entries')).toBe('1 entry');
    expect(countOf(3, 'entry', 'entries')).toBe('3 entries');
  });

  it('groups the number as well as pluralising the noun', () => {
    // The two rules were separate everywhere they appeared, and roughly half
    // the call sites applied only the second one.
    expect(countOf(4210, 'client')).toBe('4,210 clients');
  });
});

describe('shortDateLocal', () => {
  it('says nothing rather than "Invalid Date"', () => {
    expect(shortDateLocal(null)).toBe('—');
    expect(shortDateLocal(undefined)).toBe('—');
    expect(shortDateLocal('')).toBe('—');
    expect(shortDateLocal('never')).toBe('—');
  });

  it('renders a real instant as a date, in whatever locale is reading', () => {
    const out = shortDateLocal('2026-07-26T12:00:00.000Z');
    expect(out).not.toBe('—');
    expect(out).toMatch(/26/);
  });
});

describe('the Auth events tile row', () => {
  // 1,204 events, of which 1,100 accept and 104 reject, 1,050 by MAB, across
  // 1,204 distinct endpoints and a two-hour window.
  const start = Date.parse('2026-07-26T10:00:00.000Z');
  const events = Array.from({ length: 1204 }, (_, i) => ({
    time: '10:00:00',
    who: `user${i}`,
    mac: `00:11:22:33:${String(Math.floor(i / 256)).padStart(2, '0')}:${String(i % 256).padStart(2, '0')}`,
    service: 'Corp Wireless',
    method: i < 1050 ? 'MAB' : 'EAP-TLS',
    result: (i < 104 ? 'reject' : 'accept') as 'accept' | 'reject',
    reason: i < 104 ? 'Unknown endpoint' : '—',
    role: 'employee',
    nas: 'nas-1',
    plane: 'CLEARPASS' as const,
    tone: 'neutral' as const,
    tsMs: start + i * 6_000,
  }));

  it('writes every tile in the row the same way', () => {
    const stats = liveAuthStats(events);
    const labels = stats.map((s) => s.label);
    expect(labels).toContain('MAB fallbacks');
    expect(labels).toContain('Known endpoints');

    // The exact pairing that was wrong: two neighbouring tiles counting the
    // same kind of thing, one grouped and one not.
    const mab = stats.find((s) => s.label === 'MAB fallbacks')!;
    const endpoints = stats.find((s) => s.label === 'Known endpoints')!;
    expect(mab.value).toBe('1,050');
    expect(endpoints.value).toBe('1,204');

    for (const text of shown(stats)) {
      expect(ungrouped(text, 1204)).toBe(false);
      expect(ungrouped(text, 1050)).toBe(false);
      expect(ungrouped(text, 1100)).toBe(false);
    }
  });

  it('says how many events it measured, grouped, in the window caption', () => {
    const stats = liveAuthStats(events);
    const perMin = stats.find((s) => s.label === 'Auths / min')!;
    expect(perMin.delta).toMatch(/^1,204 events in a /);
  });

  it('groups the accept-rate denominator, which is the largest number here', () => {
    const stats = liveAuthStats(events);
    const rate = stats.find((s) => s.label === 'Accept rate')!;
    expect(rate.delta).toBe('1,100 of 1,204 accepted');
  });

  it('groups the counts in a reject reason, and pluralises them', () => {
    const rows = liveFailReasons(events);
    expect(rows[0]!.label).toBe('Unknown endpoint');
    expect(rows[0]!.note).toBe('104 events · 104 endpoints');

    const single = liveFailReasons([{ ...events[0]!, result: 'reject', reason: 'Bad password' }]);
    expect(single[0]!.note).toBe('1 event · 1 endpoint');
  });

  it('groups a per-hour service rate', () => {
    const rows = livePolicyServices(events);
    // 1,204 events over ~2h — a four-figure rate once the span is short.
    const compressed = events.map((e, i) => ({ ...e, tsMs: start + i }));
    const fast = livePolicyServices(compressed);
    expect(rows[0]!.name).toBe('Corp Wireless');
    expect(fast[0]!.rate).toMatch(/^\d{1,3}(,\d{3})+$/);
  });
});

describe('the Licences tile row', () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    name: 'Central Advanced AP',
    sku: 'AP-ADV',
    plane: 'GREENLAKE' as const,
    term: '1 yr',
    qty: '2,000',
    assigned: '1,500',
    pct: '75%',
    expires: '2027-01-01',
    status: 'active' as const,
    planeTone: 'neutral' as const,
    tone: 'neutral' as const,
    qtyValue: 2000,
    assignedValue: 1500,
    ...over,
  });

  it('writes the subscription count the same way as the seat count beside it', () => {
    // `Subscriptions` was the one tile on this screen written with String().
    const subs = Array.from({ length: 1002 }, () => sub());
    const stats = liveLicenseStats(subs, [], null);
    const count = stats.find((s) => s.label === 'Subscriptions')!;
    expect(count.value).toBe('1,002');
    expect(count.delta).toBe('2,004,000 seats');
  });

  it('groups assigned and unassigned seats', () => {
    const subs = [sub(), sub()];
    const stats = liveLicenseStats(subs, [], null);
    expect(stats.find((s) => s.label === 'Assigned')!.value).toBe('3,000');
    expect(stats.find((s) => s.label === 'Unassigned')!.value).toBe('1,000');
  });

  it('groups the idle-subscription caveat and agrees in number with it', () => {
    const many = Array.from({ length: 1200 }, () => sub({ assignedValue: 0 }));
    const stats = liveLicenseStats(many, [], null);
    expect(stats.find((s) => s.label === 'Unassigned')!.delta).toBe(
      '1,200 subscriptions with none assigned',
    );

    const one = liveLicenseStats([sub({ assignedValue: 0 })], [], null);
    expect(one.find((s) => s.label === 'Unassigned')!.delta).toBe(
      '1 subscription with none assigned',
    );
  });
});

describe('the Overview plane line', () => {
  it('writes both of its numbers the same way, inside one sentence', () => {
    // This is the sentence the defect was clearest in: the device count went
    // through toLocaleString and the call count did not, so a busy plane read
    // "1,234 devices · 5678 calls today" — two conventions, one clause, no
    // way for a reader to tell whether the difference meant anything.
    settings.update({
      planes: {
        central: {
          gatewayBaseUrl: 'https://example.invalid',
          clientId: 'id',
          clientSecret: 'secret',
        },
      },
    });
    registry.reinitPlane('central');
    registry.markSyncResult('central', true, { deviceCount: 1234 });
    for (let i = 0; i < 5678; i += 1) {
      registry.recordCall('central', { path: '/devices', ms: 1, code: '200' });
    }

    const row = liveOverviewPlanes().find((r) => r.name.toLowerCase().includes('central'));
    expect(row).toBeTruthy();
    expect(row!.scope).toBe('1,234 devices · 5,678 calls today');
  });
});
