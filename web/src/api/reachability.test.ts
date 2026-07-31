/**
 * web/src/api/reachability.test.ts — the backend-reachability signal.
 *
 * Why this exists: every screen getter answers an unreachable backend with the
 * authored demo fixtures. That is deliberate (the web app runs standalone),
 * but the payload it produces is byte-identical to the one a portal running in
 * demo mode serves, so nothing downstream could tell "showing samples" from
 * "the portal is gone". A tab left open on live data re-rendered, on the next
 * poll after a crash, as a complete and plausible estate that does not exist.
 *
 * These tests pin the one thing that makes the difference visible: an
 * unreachable fetch is announced, and an answered one — whatever it answers —
 * takes the announcement back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetch,
  fetchScreen,
  isBackendReachable,
  noteResponseStatus,
  onAuthLapse,
  onBackendReachabilityChange,
  resetBackendReachability,
} from './core';
import { ackAlert } from './actions';
import { runGreenLakeAction } from './greenlake';
import { searchInventory } from './inventory';

afterEach(() => {
  resetBackendReachability();
  vi.unstubAllGlobals();
});

/** A fetch that never connects — the exact case that substitutes fixtures. */
function stubUnreachable() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
  );
}

function stubAnswer(status: number, body: unknown = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: vi.fn().mockResolvedValue(body),
      text: vi.fn().mockResolvedValue(''),
      headers: { get: () => 'application/json' },
    }),
  );
}

describe('backend reachability signal', () => {
  // Starting pessimistic would warn before a single request had been made,
  // which is a guess rather than an observation.
  it('starts optimistic, because nothing has failed yet', () => {
    expect(isBackendReachable()).toBe(true);
  });

  it('reports a fetch that never connected, and hands fixtures over knowingly', async () => {
    const seen: boolean[] = [];
    onBackendReachabilityChange((r) => seen.push(r));
    stubUnreachable();

    const result = await fetchScreen('/api/overview');

    expect(result.kind).toBe('unreachable');
    expect(isBackendReachable()).toBe(false);
    expect(seen).toEqual([false]);
  });

  // A poll every 60 seconds against a dead backend must not re-notify each
  // tick; listeners hear about the transition, not about every failure.
  it('announces the transition rather than every failed request', async () => {
    const seen: boolean[] = [];
    onBackendReachabilityChange((r) => seen.push(r));
    stubUnreachable();

    await fetchScreen('/api/overview');
    await fetchScreen('/api/overview');
    await fetchScreen('/api/alerts');

    expect(seen).toEqual([false]);
  });

  it('clears as soon as anything answers again', async () => {
    const seen: boolean[] = [];
    onBackendReachabilityChange((r) => seen.push(r));
    stubUnreachable();
    await fetchScreen('/api/overview');
    expect(isBackendReachable()).toBe(false);

    stubAnswer(200, { stats: [] });
    await fetchScreen('/api/overview');

    expect(isBackendReachable()).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  // An HTTP error is not an unreachable backend. It already travels to the
  // screen as an explicit apiError and never becomes fixtures, so raising the
  // fixtures warning on it would explain the failure wrongly.
  it('does not call an answered HTTP error unreachable', async () => {
    stubAnswer(500);

    const result = await fetchScreen('/api/overview');

    expect(result.kind).toBe('http-error');
    expect(isBackendReachable()).toBe(true);
  });

  // A 401 means the portal is up and does not know who we are. That is the
  // auth gate's story, not the fixtures story, and conflating them would put
  // "nothing here is your estate" in front of a perfectly live portal.
  it('treats a 401 as answered — a lost session is not a missing backend', () => {
    noteResponseStatus(401);
    expect(isBackendReachable()).toBe(true);
  });

  it('stops notifying a listener that unsubscribed', async () => {
    const seen: boolean[] = [];
    const stop = onBackendReachabilityChange((r) => seen.push(r));
    stop();
    stubUnreachable();

    await fetchScreen('/api/overview');

    expect(isBackendReachable()).toBe(false);
    expect(seen).toEqual([]);
  });
});

/**
 * The auth-lapse signal used to reach only the screen readers, because only
 * they went through fetchScreen/fetchDetail. Every action and every write
 * called `fetch` directly, so a session that expired while a tab sat open
 * produced, on the very next click, a message blaming the plane — "GreenLake
 * refused the change", "inventory search failed — HTTP 401" — with nothing on
 * the page offering a way back. That is exactly the failure onAuthLapse was
 * built to prevent, missed on the half of the app where the operator is
 * trying to change something.
 */
describe('apiFetch — actions and writes report a lapsed session', () => {
  function stub(status: number, body: unknown = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: vi.fn().mockResolvedValue(body),
        text: vi.fn().mockResolvedValue(''),
        headers: { get: () => 'application/json' },
      }),
    );
  }

  it('raises the lapse signal for a 401 on a write action', async () => {
    let lapses = 0;
    onAuthLapse(() => {
      lapses += 1;
    });
    stub(401, { error: 'not authenticated' });

    const r = await runGreenLakeAction('inviteUser', { email: 'a@b.com' });

    expect(r.ok).toBe(false);
    expect(lapses).toBe(1);
  });

  it('raises the lapse signal for a 401 on an alert acknowledgement', async () => {
    let lapses = 0;
    onAuthLapse(() => {
      lapses += 1;
    });
    stub(401, { error: 'not authenticated' });

    const r = await ackAlert({ plane: 'central', alertId: 'a-1' }, 'CHG-1');

    expect(r.ok).toBe(false);
    expect(lapses).toBe(1);
  });

  it('raises the lapse signal for a 401 on inventory search', async () => {
    let lapses = 0;
    onAuthLapse(() => {
      lapses += 1;
    });
    stub(401);

    await expect(searchInventory('sw')).rejects.toThrow();
    expect(lapses).toBe(1);
  });

  // A plane genuinely refusing a write is not a lapsed session. The signal is
  // a prompt to re-ask the server, and AuthGate only closes the gate when the
  // server itself says the session is gone — but a 200 must not prompt at all.
  it('stays quiet when the action simply succeeded', async () => {
    let lapses = 0;
    onAuthLapse(() => {
      lapses += 1;
    });
    stub(200, { action: 'inviteUser', outcome: 'applied', detail: 'sent' });

    await runGreenLakeAction('inviteUser', { email: 'a@b.com' });

    expect(lapses).toBe(0);
  });

  it('marks the backend unreachable when a write cannot connect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const r = await runGreenLakeAction('inviteUser', { email: 'a@b.com' });

    expect(r.ok).toBe(false);
    expect(isBackendReachable()).toBe(false);
  });

  // An abort is the caller cancelling its own request — a superseded search or
  // an unmounting component. Reporting it as a missing backend would raise the
  // fixtures warning over a portal that is answering perfectly well.
  it('does not call an aborted request an unreachable backend', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));

    await expect(apiFetch('/api/inventory/search?q=x')).rejects.toThrow();

    expect(isBackendReachable()).toBe(true);
  });
});
