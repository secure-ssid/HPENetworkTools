/**
 * systems/facts.test.ts — how old the Systems screen says a plane's last good
 * sync is.
 *
 * The age and the stale badge sit on the same row and answer the same
 * question, so they may not be derived from different clocks. `ageSec` is the
 * server's own answer, measured against the same clock that wrote `lastSync`;
 * re-aging the ISO string in the browser measured one machine's stamp with
 * another's.
 */

import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_TOLERANCE_MS } from '@hpe/shared';
import { callsFactValue, mergedFacts, relTime, retryNote, staleTitle, storedScopes, syncAgeText } from './facts';
import type { LivePlaneState } from '../../api/client';
import type { SystemRow } from '@hpe/shared';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function live(over: Partial<LivePlaneState> = {}): LivePlaneState {
  return {
    id: 'central',
    linked: true,
    health: 'healthy',
    lastSync: ago(30_000),
    deviceCount: 41,
    callsToday: 12,
    note: null,
    recentCalls: [],
    ...over,
  };
}

describe('syncAgeText — one clock, not two', () => {
  it('reports the age the server measured, not the one the browser would', () => {
    // The stamp reads 30s old here; the server, on its own clock, aged it to
    // 12s. Its number is the one `stale` was decided from, so its number is
    // the one that goes on the row.
    expect(syncAgeText(live({ ageSec: 12 }), NOW)).toBe('12s ago');
    expect(syncAgeText(live({ ageSec: 6 * 3600 }), NOW)).toBe('6h 0m ago');
    expect(syncAgeText(live({ ageSec: 3 * 86_400 }), NOW)).toBe('3d ago');
  });

  it('says never only about a plane that has never synced', () => {
    expect(syncAgeText(live({ lastSync: null, ageSec: null }), NOW)).toBe('never');
  });

  it('refuses to call an unreadable stamp a plane that never synced', () => {
    // ageSec is null for a stamp that will not parse or is further ahead than
    // drift explains. The plane HAS synced; only its age is unknown, and
    // 'never' is the one word that contradicts that.
    const unreadable = live({ lastSync: ago(-30 * 86_400_000), ageSec: null });
    expect(syncAgeText(unreadable, NOW)).toContain('age unreadable');
    expect(syncAgeText(unreadable, NOW)).not.toContain('never');
  });

  it('falls back to this clock only when the server sent no age at all', () => {
    // ageSec absent (not null) is an older server. Nothing better exists.
    expect(syncAgeText(live({ lastSync: ago(45_000) }), NOW)).toBe('45s ago');
  });
});

describe('relTime — the browser-clock fallback', () => {
  it('reads a stamp inside the skew window as brand new', () => {
    expect(relTime(ago(-5_000), NOW)).toBe('0s ago');
    expect(relTime(ago(-CLOCK_SKEW_TOLERANCE_MS), NOW)).toBe('0s ago');
  });

  it('never dresses a stamp from beyond the skew window as fresh', () => {
    // Math.max(0, …) turned a stamp years ahead into '0s ago' — an invented
    // freshness on the screen whose whole job is reporting freshness.
    expect(relTime(ago(-CLOCK_SKEW_TOLERANCE_MS - 1_000), NOW)).toBe('—');
    expect(relTime(ago(-400 * 86_400_000), NOW)).toBe('—');
  });

  it('still separates never-synced from unparseable', () => {
    expect(relTime(null, NOW)).toBe('never');
    expect(relTime('not-a-date', NOW)).toBe('—');
  });
});

describe('the Last sync fact and the stale tooltip agree with the badge', () => {
  const row = { facts: [{ k: 'Last sync', v: '—' }] } as SystemRow;

  it('renders the served age into the fact strip', () => {
    const facts = mergedFacts(row, live({ ageSec: 12, deviceCount: null }));
    expect(facts.find((f) => f.k === 'Last sync')?.v).toBe('12s ago');
  });

  it('never puts the word never into the sentence about an aged-out plane', () => {
    // The registry does not report a never-synced plane as `stale` at all, so
    // this sentence is only said about a plane that has synced.
    const title = staleTitle(live({ lastSync: ago(-30 * 86_400_000), ageSec: null, stale: true }));
    expect(title).toContain('age unreadable');
    expect(title).toContain("past the registry's staleness window");
    expect(title).not.toContain('last good sync never');
  });
});

describe('the fact strip writes all of its numbers the same way', () => {
  // Three facts sit one line apart on this card, and only the middle one used
  // to be grouped: a plane with 1,234 devices and 1,234 calls against a 5,000
  // budget rendered `1234` above `1,234 / 5,000`. Same quantity, same card,
  // two conventions — the server's copy of this rule did it too, and the two
  // copies are why the rule now lives in shared/.
  const row = { facts: [{ k: 'Devices', v: '—' }] } as SystemRow;

  it('groups the device count, not just the call count beside it', () => {
    const facts = mergedFacts(row, live({ deviceCount: 1234, callsToday: 1234, callBudget: 5000 }));
    expect(facts.find((f) => f.k === 'Devices')?.v).toBe('1,234');
  });

  it('groups a count fact appended to a row that had none', () => {
    const bare = { facts: [], planeId: 'central' } as unknown as SystemRow;
    const facts = mergedFacts(bare, live({ deviceCount: 8042 }));
    expect(facts.find((f) => f.k === 'Devices')?.v).toBe('8,042');
  });

  it('groups the call count whether or not the plane has a known budget', () => {
    // The two branches of one function disagreed: with a budget the number
    // was grouped, without one it was not, so the same plane changed the way
    // it wrote its own count the moment the portal learned its tier.
    expect(callsFactValue(live({ callsToday: 19_204, callBudget: 20_000 }))).toBe('19,204 / 20,000');
    expect(callsFactValue(live({ callsToday: 19_204, callBudget: null }))).toBe('19,204');
  });

  it('agrees in number when the poller has failed exactly once', () => {
    expect(retryNote(live({ consecutiveFailures: 1 }))).toBe('1 consecutive failed poll');
    expect(retryNote(live({ consecutiveFailures: 3 }))).toBe('3 consecutive failed polls');
    expect(retryNote(live({ consecutiveFailures: 0 }))).toBeNull();
  });
});

describe('stored connector scopes are the write authority', () => {
  it('does not invent write:direct from an adapter capability', () => {
    const row = {
      configText: 'scopes: read:inventory, read:clients-auth',
    } as SystemRow;

    expect(storedScopes(row, 'central', live({ capabilities: { directWrite: true } }))).toEqual([
      'read:inventory',
      'read:clients-auth',
    ]);
  });
});
