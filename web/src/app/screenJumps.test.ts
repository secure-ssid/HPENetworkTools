import { describe, expect, it } from 'vitest';
import { matchScreenJumps, normalizeScreenJumpQuery } from './screenJumps';

describe('normalizeScreenJumpQuery', () => {
  it('strips go/open prefixes', () => {
    expect(normalizeScreenJumpQuery('  Go to Alerts ')).toBe('alerts');
    expect(normalizeScreenJumpQuery('goto tickets')).toBe('tickets');
    expect(normalizeScreenJumpQuery('open mist')).toBe('mist');
    expect(normalizeScreenJumpQuery('devices')).toBe('devices');
  });
});

describe('matchScreenJumps', () => {
  it('returns nothing for short or empty queries', () => {
    expect(matchScreenJumps('')).toEqual([]);
    expect(matchScreenJumps('a')).toEqual([]);
    expect(matchScreenJumps('go a')).toEqual([]);
  });

  it('matches screen labels and common aliases', () => {
    const alerts = matchScreenJumps('alerts');
    expect(alerts[0]?.path).toBe('/alerts');
    expect(alerts[0]?.kind).toBe('screen');
    expect(alerts[0]?.meta).toMatch(/Go to/);

    expect(matchScreenJumps('go licences')[0]?.path).toBe('/licenses');
    expect(matchScreenJumps('recs')[0]?.path).toBe('/recommendations');
    expect(matchScreenJumps('auth events')[0]?.path).toBe('/auth-events');
    expect(matchScreenJumps('connected systems')[0]?.path).toBe('/systems');
  });

  it('prefers exact label hits and de-dupes paths', () => {
    const hits = matchScreenJumps('central');
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.path)).size).toBe(hits.length);
  });
});
