import { describe, expect, it } from 'vitest';
import { normalizePlaneIds, planePollDeltaAnnouncement } from './planePollDelta';

describe('normalizePlaneIds', () => {
  it('trims, drops empties, dedupes, sorts', () => {
    expect(normalizePlaneIds([' mist ', 'central', 'mist', '', 'aos8'])).toEqual([
      'aos8',
      'central',
      'mist',
    ]);
  });
});

describe('planePollDeltaAnnouncement', () => {
  it('returns null when the set is unchanged', () => {
    expect(planePollDeltaAnnouncement(['central'], ['central'])).toBeNull();
    expect(planePollDeltaAnnouncement([], [])).toBeNull();
    expect(planePollDeltaAnnouncement(['b', 'a'], ['a', 'b'])).toBeNull();
  });

  it('announces newly degraded planes', () => {
    const msg = planePollDeltaAnnouncement([], ['central']);
    expect(msg).toMatch(/central became degraded/i);
    expect(msg).toMatch(/1 plane degraded/i);
  });

  it('announces recovery and all-healthy when the set clears', () => {
    const msg = planePollDeltaAnnouncement(['mist', 'central'], []);
    expect(msg).toMatch(/recovered/i);
    expect(msg).toMatch(/All linked planes healthy/i);
  });

  it('combines enter and leave in one utterance', () => {
    const msg = planePollDeltaAnnouncement(['central'], ['mist']);
    expect(msg).toMatch(/mist became degraded/i);
    expect(msg).toMatch(/central recovered/i);
  });
});
