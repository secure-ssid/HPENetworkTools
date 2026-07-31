/**
 * systems/PlaneRow.test.ts — the two page-level banners the Systems screen
 * derives from the registry.
 *
 * Both exist because the per-row badge is one word and the detail drawer is a
 * click away. The registry knows exactly why a plane is failing; the question
 * these answer is whether an operator finds out without going looking.
 */

import { describe, expect, it } from 'vitest';
import { pollFailureBanner, throttleBanner } from './PlaneRow';
import type { LivePlaneState } from '../../api/client';
import type { SystemRow } from '@hpe/shared';

function live(over: Partial<LivePlaneState> = {}): LivePlaneState {
  return {
    id: 'central',
    linked: true,
    health: 'healthy',
    lastSync: '2026-07-26T11:59:30.000Z',
    deviceCount: 41,
    callsToday: 12,
    note: null,
    recentCalls: [],
    ...over,
  };
}

const row = (name: string): SystemRow => ({ name }) as SystemRow;

const view = (name: string, over: Partial<LivePlaneState> = {}) => ({
  row: row(name),
  live: live(over),
});

describe('pollFailureBanner', () => {
  /* The case this was written for. Central held placeholder credentials, the
     registry recorded exactly why, and the screen showed the word 'degraded'
     on a row — the reason was in a drawer, in the same muted grey as a
     healthy plane's summary line. */
  it('names the plane and quotes the registry note as written', () => {
    const banner = pollFailureBanner([
      view('Central', {
        consecutiveFailures: 4,
        lastSync: null,
        note: "poll failed: central pull: section 'devices' failed — auth: neither token endpoint accepted these credentials",
      }),
    ]);
    expect(banner?.title).toBe('Central is not being polled successfully');
    expect(banner?.body).toContain('neither token endpoint accepted these credentials');
    expect(banner?.body).toContain('4 consecutive failed polls');
  });

  /* Stale numbers and no numbers are different situations and the banner has
     to tell them apart — the second one means nothing on the screen came from
     that plane at all. */
  it('separates a plane that has never synced from one showing an older read', () => {
    const never = pollFailureBanner([view('Central', { consecutiveFailures: 1, lastSync: null, note: 'auth: 401' })]);
    expect(never?.body).toContain('never completed one');

    const stale = pollFailureBanner([
      view('Central', { consecutiveFailures: 1, lastSync: '2026-07-26T09:00:00.000Z', note: 'auth: 401' }),
    ]);
    expect(stale?.body).not.toContain('never completed one');
  });

  /* throttleBanner returns the first match and stops. A failing poll is not a
     thing to report one of. */
  it('names every failing plane, not just the first', () => {
    const banner = pollFailureBanner([
      view('Central', { consecutiveFailures: 2, note: 'auth: 401' }),
      view('GreenLake'),
      view('Mist', { consecutiveFailures: 1, note: 'connect ETIMEDOUT' }),
    ]);
    expect(banner?.title).toBe('2 systems are not being polled successfully');
    expect(banner?.body).toContain('Central');
    expect(banner?.body).toContain('Mist');
    expect(banner?.body).not.toContain('GreenLake');
  });

  it('says the registry recorded no reason rather than inventing one', () => {
    const banner = pollFailureBanner([view('Mist', { consecutiveFailures: 1, note: null })]);
    expect(banner?.body).toContain('the registry recorded no reason');
  });

  it('counts one failed poll in the singular', () => {
    const banner = pollFailureBanner([view('Mist', { consecutiveFailures: 1, note: 'x' })]);
    expect(banner?.body).toContain('1 consecutive failed poll)');
  });

  // -- guards: what must NOT raise a banner ---------------------------------

  it('stays silent when every plane is polling', () => {
    expect(pollFailureBanner([view('Central'), view('GreenLake')])).toBeNull();
    expect(pollFailureBanner([view('Central', { consecutiveFailures: 0 })])).toBeNull();
  });

  /* A plane nobody configured is not failing; it was never asked. */
  it('ignores an unlinked plane', () => {
    expect(pollFailureBanner([view('Classic', { linked: false, consecutiveFailures: 3 })])).toBeNull();
  });

  /* 'degraded' also covers a poll that finished and returned part of the
     estate. That is a different claim, and this banner does not make it. */
  it('ignores a degraded plane whose polls are still completing', () => {
    expect(
      pollFailureBanner([view('SSE', { health: 'degraded', consecutiveFailures: 0, note: '2 unavailable' })]),
    ).toBeNull();
  });
});

describe('throttleBanner', () => {
  it('names a linked plane whose recent calls carry 429s, and counts them', () => {
    const banner = throttleBanner([
      view('Central', {
        recentCalls: [
          { time: '11:00', path: '/a', ms: 10, code: '429' },
          { time: '11:01', path: '/b', ms: 10, code: '200' },
        ] as LivePlaneState['recentCalls'],
      }),
    ]);
    expect(banner?.title).toBe('Central is throttling us');
    expect(banner?.body).toContain('1 of the last 2 calls');
  });

  it('raises nothing for a plane the portal has never called', () => {
    expect(throttleBanner([view('Classic', { linked: false })])).toBeNull();
    expect(throttleBanner([view('Central')])).toBeNull();
  });
});
