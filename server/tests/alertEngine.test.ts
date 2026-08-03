/**
 * server/tests/alertEngine.test.ts — the shared alert engine's contracts.
 *
 * Covers shared/alertEngine.ts (via the @hpe/shared barrel, the way the
 * server route and the browser screen both import it):
 *   - fingerprint normalisation: case and whitespace collapse, so one problem
 *     lands in one group;
 *   - grouping: count, latest firing, first/last seen, input-order stability;
 *   - silence matching: AND semantics over optional matchers, case-insensitive
 *     title substring, and a criterion-less silence matching NOTHING;
 *   - expiry: active strictly while now < until, unparseable until = inactive;
 *   - partition: silenced groups come back WITH their silence, never dropped.
 */

import { describe, expect, it } from 'vitest';
import {
  alertFingerprint,
  groupAlerts,
  partitionAlertGroups,
  silenceIsActive,
  silenceMatches,
  type AlertRow,
  type AlertSilence,
} from '@hpe/shared';

function row(over: Partial<AlertRow> = {}): AlertRow {
  return {
    sev: 'P2',
    tone: 'warning',
    title: 'gw-edge-1 tunnel flap ×14 in an hour',
    detail: 'ipsec to dc1 · mtu blackhole suspected',
    siteId: 'campus-01',
    siteName: 'Campus-01 HQ',
    plane: 'AOS-10',
    state: 'open',
    age: '55m',
    device: 'gw-edge-1',
    ...over,
  };
}

function silence(over: Partial<AlertSilence> = {}): AlertSilence {
  return {
    id: 'sil-test',
    reason: 'ISP maintenance window',
    createdAt: '2026-08-01T00:00:00.000Z',
    until: '2026-08-01T08:00:00.000Z',
    ...over,
  };
}

describe('alertFingerprint', () => {
  it('is stable for identical rows', () => {
    expect(alertFingerprint(row())).toBe(alertFingerprint(row()));
  });

  it('normalises case and collapses whitespace', () => {
    const a = row({ device: '  GW-Edge-1', title: 'GW-EDGE-1 TUNNEL FLAP ×14 IN AN HOUR' });
    const b = row({ title: 'gw-edge-1 tunnel  flap ×14 in an hour' });
    expect(alertFingerprint(a)).toBe(alertFingerprint(b));
  });

  it('differs when any of plane, device or title differs', () => {
    const base = alertFingerprint(row());
    expect(alertFingerprint(row({ plane: 'CENTRAL' }))).not.toBe(base);
    expect(alertFingerprint(row({ device: 'gw-edge-2' }))).not.toBe(base);
    expect(alertFingerprint(row({ title: 'gw-edge-1 tunnel down' }))).not.toBe(base);
  });
});

describe('groupAlerts', () => {
  it('collapses firings of one fingerprint into one counted group', () => {
    const groups = groupAlerts([
      row({ age: '55m', detail: 'first' }),
      row({ age: '12m', detail: 'latest' }),
      row({ age: '38m', detail: 'middle' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].latest.detail).toBe('latest');
    expect(groups[0].firstSeen).toBe('55m');
    expect(groups[0].lastSeen).toBe('12m');
  });

  it('keeps the same title on two devices as two groups — two findings', () => {
    const groups = groupAlerts([row(), row({ device: 'gw-edge-2' })]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });

  it('preserves the input order of first occurrence', () => {
    const groups = groupAlerts([
      row({ title: 'b problem', device: 'd1' }),
      row({ title: 'a problem', device: 'd2' }),
      row({ title: 'b problem', device: 'd1', age: '1m' }),
    ]);
    expect(groups.map((g) => g.latest.title)).toEqual(['b problem', 'a problem']);
    expect(groups[0].latest.age).toBe('1m');
  });

  it('treats an unparseable age as brand new, not ancient history', () => {
    const groups = groupAlerts([row({ age: '3d', detail: 'old' }), row({ age: '???', detail: 'odd' })]);
    expect(groups[0].latest.detail).toBe('odd');
    expect(groups[0].firstSeen).toBe('3d');
  });
});

describe('silenceMatches', () => {
  it('matches on plane only', () => {
    expect(silenceMatches(silence({ plane: 'aos-10' }), row())).toBe(true);
    expect(silenceMatches(silence({ plane: 'CENTRAL' }), row())).toBe(false);
  });

  it('matches on device only, normalised', () => {
    expect(silenceMatches(silence({ device: ' GW-edge-1 ' }), row())).toBe(true);
    expect(silenceMatches(silence({ device: 'gw-edge-2' }), row())).toBe(false);
  });

  it('matches a case-insensitive title substring', () => {
    expect(silenceMatches(silence({ titleContains: 'TUNNEL FLAP' }), row())).toBe(true);
    expect(silenceMatches(silence({ titleContains: 'bgp' }), row())).toBe(false);
  });

  it('ANDs every matcher that is set', () => {
    const s = silence({ plane: 'AOS-10', device: 'gw-edge-1', titleContains: 'flap' });
    expect(silenceMatches(s, row())).toBe(true);
    expect(silenceMatches(s, row({ device: 'gw-edge-2' }))).toBe(false);
  });

  it('matches NOTHING when no matcher is set', () => {
    expect(silenceMatches(silence({}), row())).toBe(false);
    expect(silenceMatches(silence({ plane: '  ', titleContains: '' }), row())).toBe(false);
  });
});

describe('silenceIsActive', () => {
  const now = Date.parse('2026-08-01T04:00:00.000Z');

  it('is active strictly before until', () => {
    expect(silenceIsActive(silence({ until: '2026-08-01T08:00:00.000Z' }), now)).toBe(true);
    expect(silenceIsActive(silence({ until: '2026-08-01T03:59:59.000Z' }), now)).toBe(false);
    // At exactly until, the box has closed.
    expect(silenceIsActive(silence({ until: '2026-08-01T04:00:00.000Z' }), now)).toBe(false);
  });

  it('treats an unparseable until as inactive — a malformed clock is not a permanent hush', () => {
    expect(silenceIsActive(silence({ until: 'whenever' }), now)).toBe(false);
  });
});

describe('partitionAlertGroups', () => {
  const now = Date.parse('2026-08-01T04:00:00.000Z');
  const groups = groupAlerts([row(), row({ title: 'DHCP pool 92% used', device: 'sw-core-a', plane: 'CENTRAL' })]);

  it('benches matching groups WITH their silence and keeps the rest active', () => {
    const { active, silenced } = partitionAlertGroups(
      groups,
      [silence({ device: 'gw-edge-1', reason: 'tunnel work' })],
      now,
    );
    expect(active.map((g) => g.latest.title)).toEqual(['DHCP pool 92% used']);
    expect(silenced).toHaveLength(1);
    expect(silenced[0].group.latest.device).toBe('gw-edge-1');
    expect(silenced[0].silence.reason).toBe('tunnel work');
  });

  it('ignores expired silences', () => {
    const { active, silenced } = partitionAlertGroups(
      groups,
      [silence({ device: 'gw-edge-1', until: '2026-08-01T01:00:00.000Z' })],
      now,
    );
    expect(active).toHaveLength(2);
    expect(silenced).toHaveLength(0);
  });

  it('lets the first matching active silence win the reason slot', () => {
    const { silenced } = partitionAlertGroups(
      groups,
      [
        silence({ id: 's1', plane: 'AOS-10', reason: 'first' }),
        silence({ id: 's2', device: 'gw-edge-1', reason: 'second' }),
      ],
      now,
    );
    expect(silenced[0].silence.id).toBe('s1');
  });
});
