/**
 * server/tests/registryPoller.test.ts — what the registry and the poller are
 * allowed to CLAIM about a plane.
 *
 * The honesty rules land here first: a sync stamp must mean data arrived, a
 * plane that keeps failing must back off instead of re-polling the quota it is
 * already exceeding, a dataset the pull could not read must not inherit the
 * plane's freshness, and a stub plane must not manufacture successes. Every
 * test drives the real PlaneRegistry against a throwaway settings file, or the
 * real Poller against injected adapter seams — no network, no timers.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaneRegistry } from '../src/planes/registry';
import type { PlaneAdapter } from '../src/planes/types';
import type { SettingsStore } from '../src/config/settings';

/** Run `fn` against a registry backed by a throwaway settings file. */
async function withRegistry(
  planes: Record<string, Record<string, string>>,
  fn: (reg: PlaneRegistry) => void | Promise<void>,
  pollIntervalSec = 60,
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hpe-reg-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  try {
    const { SettingsStore: Store } = await import('../src/config/settings');
    const { PlaneRegistry: Registry } = await import('../src/planes/registry');
    const store = new Store();
    store.update({ planes, pollIntervalSec });
    await fn(new Registry(store));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HPE_SETTINGS_PATH;
  }
}

const MIST = { apiHost: 'api.mist.com', orgId: 'org-1', token: 'tok' };

afterEach(() => {
  vi.useRealTimers();
});

describe('registry — a partial pull is a sync, but not a complete one', () => {
  it('holds the plane at warning and reports it stale with the reason', async () => {
    await withRegistry({ mist: MIST }, (reg) => {
      reg.markSyncResult('mist', true, { deviceCount: 2, partial: ['clients'] });
      const st = reg.state('mist');
      expect(st.lastSync).not.toBeNull(); // the sync did happen
      expect(st.health).toBe('warning');
      // …but a dataset that was never read must not render behind a verified
      // badge, so consumers get the stale flag with the reason.
      expect(st).toMatchObject({ stale: true, reason: 'partial' });
    });
  });
});

describe('registry — failure backoff', () => {
  it('grows the wait per consecutive failure, caps it, and clears it on success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
    await withRegistry({ mist: MIST }, (reg) => {
      const waitSec = (): number => {
        const at = reg.state('mist').nextAttemptAt;
        return at ? Math.round((Date.parse(at) - Date.now()) / 1000) : 0;
      };
      reg.markSyncResult('mist', false, { note: 'HTTP 429' });
      expect(reg.state('mist').consecutiveFailures).toBe(1);
      expect(waitSec()).toBe(60); // one poll interval
      reg.markSyncResult('mist', false, {});
      expect(waitSec()).toBe(120);
      reg.markSyncResult('mist', false, {});
      expect(waitSec()).toBe(240);
      for (let i = 0; i < 8; i += 1) reg.markSyncResult('mist', false, {});
      expect(waitSec()).toBe(600); // capped — never grows unbounded

      reg.markSyncResult('mist', true, { deviceCount: 1 });
      expect(reg.state('mist').consecutiveFailures).toBe(0);
      expect(reg.state('mist').nextAttemptAt).toBeNull();
    });
  });

  it('logs the backoff and the recovery as plane events, never a credential', async () => {
    await withRegistry({ mist: MIST }, (reg) => {
      reg.markSyncResult('mist', false, { note: 'poll failed: HTTP 429' });
      reg.markSyncResult('mist', true, { deviceCount: 1 });
      const events = reg.recentEvents('mist');
      expect(events[0].what).toContain('sync recovered');
      expect(events[1].what).toContain('backing off');
      expect(events.every((e) => e.who === 'poller')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('tok');
    });
  });

  it('records a credential change as an operator event and keeps the log across the swap', async () => {
    await withRegistry({ mist: MIST }, (reg) => {
      reg.markSyncResult('mist', false, {});
      reg.reinitPlane('mist');
      const events = reg.recentEvents('mist');
      expect(events[0]).toMatchObject({ what: 'credentials saved — adapter rebuilt', who: 'operator' });
      expect(events).toHaveLength(2); // the earlier poll event survived the rebuild
    });
  });
});

describe('registry — a re-link releases the outgoing adapter', () => {
  /** Replace the plane's live adapter with a stand-in and hand back both the
   *  stand-in and a reader for whichever adapter the registry holds now. */
  function swapIn(
    reg: PlaneRegistry,
    id: string,
    dispose: PlaneAdapter['dispose'],
  ): { outgoing: PlaneAdapter; current: () => PlaneAdapter } {
    const runtime = (reg as unknown as { runtime: Map<string, { adapter: PlaneAdapter }> }).runtime;
    const slot = runtime.get(id)!;
    const outgoing: PlaneAdapter = {
      id: slot.adapter.id,
      state: () => slot.adapter.state(),
      pull: async () => ({}),
      dispose,
    };
    runtime.set(id, { ...slot, adapter: outgoing });
    return { outgoing, current: () => runtime.get(id)!.adapter };
  }

  it('calls dispose() exactly once on the replaced adapter, never on the new one', async () => {
    await withRegistry({ mist: MIST }, (reg) => {
      const dispose = vi.fn(async () => {});
      const { outgoing, current } = swapIn(reg, 'mist', dispose);

      reg.reinitPlane('mist');
      expect(dispose).toHaveBeenCalledTimes(1);
      // The session belonged to the object being thrown away — the registry
      // must have installed a fresh adapter, not kept the disposed one.
      expect(current()).not.toBe(outgoing);

      // A second re-link disposes whatever is outgoing THEN, not the object
      // that was already released.
      reg.reinitPlane('mist');
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  it('completes the re-link when dispose() rejects, throws synchronously, or never settles', async () => {
    await withRegistry({ mist: MIST }, (reg) => {
      // Rejects: the far side answered with an error.
      const rejects = vi.fn(async () => {
        throw new Error('controller unreachable');
      });
      const a = swapIn(reg, 'mist', rejects);
      expect(() => reg.reinitPlane('mist')).not.toThrow();
      expect(rejects).toHaveBeenCalledTimes(1);
      expect(a.current()).not.toBe(a.outgoing);

      // Throws synchronously, before any promise exists to attach .catch() to.
      const sync = vi.fn(() => {
        throw new Error('no session to release');
      }) as unknown as PlaneAdapter['dispose'];
      const b = swapIn(reg, 'mist', sync);
      expect(() => reg.reinitPlane('mist')).not.toThrow();
      expect(b.current()).not.toBe(b.outgoing);

      // Hangs: the release is fire-and-forget, so the operator's credential
      // save must return without waiting on the far side at all.
      const hang = vi.fn(() => new Promise<void>(() => {})) as unknown as PlaneAdapter['dispose'];
      const c = swapIn(reg, 'mist', hang);
      const view = reg.reinitPlane('mist');
      expect(hang).toHaveBeenCalledTimes(1);
      expect(view.linked).toBe(true);
      expect(c.current()).not.toBe(c.outgoing);
      // The re-link is still recorded as the operator event it is.
      expect(reg.recentEvents('mist')[0]).toMatchObject({ who: 'operator' });
    });
  });

  it('re-links a plane whose adapter has no dispose() at all', async () => {
    await withRegistry({ mist: MIST }, (reg) => {
      // StubAdapter/UnconfiguredAdapter and the planes without a session to
      // release do not implement dispose — the optional call must be a no-op.
      const { outgoing, current } = swapIn(reg, 'mist', undefined);
      expect(() => reg.reinitPlane('mist')).not.toThrow();
      expect(current()).not.toBe(outgoing);
    });
  });
});

describe('registry — "Calls today" is today\'s', () => {
  it('rolls the counter over at local midnight on READ, not only on the next call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 1, 23, 59, 0)); // local time — the counter is local
    await withRegistry({ mist: MIST }, (reg) => {
      reg.recordCall('mist', { path: 'GET /api/v1/self', ms: 12, code: '200' });
      expect(reg.state('mist').callsToday).toBe(1);
      // A plane that stops calling (polling paused, backed off, unlinked) never
      // reaches recordCall again — the read path has to roll the day over or
      // the fact strip shows yesterday's total as today's.
      vi.setSystemTime(new Date(2026, 2, 2, 9, 0, 0));
      expect(reg.state('mist').callsToday).toBe(0);
      expect(reg.states().mist.callsToday).toBe(0);
    });
  });
});

// -- poller ------------------------------------------------------------------

type Tickable = { tick: (id: string, force?: boolean) => Promise<'ok' | 'error' | 'skipped'> };

interface MarkCall {
  ok: boolean;
  info: { deviceCount?: number | null; note?: string; partial?: readonly string[]; stamp?: boolean };
}

/** A registry stand-in that records what the poller asked it to stamp. */
function fakeRegistry(adapter: unknown, marks: MarkCall[], calls: string[]): PlaneRegistry {
  return {
    get: () => adapter,
    states: () => ({ mist: { linked: true, lastSync: null } }),
    recordCall: (_id: string, call: { path: string }) => calls.push(call.path),
    markSyncResult: (_id: string, ok: boolean, info: MarkCall['info'] = {}) => marks.push({ ok, info }),
  } as unknown as PlaneRegistry;
}

const liveStore = { get: () => ({ demoMode: false, pollIntervalSec: 5 }) } as unknown as SettingsStore;

describe('poller — a cycle only claims what happened', () => {
  it('skips a stub plane outright: no call record, no sync stamp, no history row', async () => {
    const { Poller } = await import('../src/services/poller');
    const { StubAdapter } = await import('../src/planes/registry');
    const state = {
      id: 'classic' as const,
      linked: true,
      health: 'warning' as const,
      lastSync: null,
      deviceCount: null,
      callsToday: 0,
      note: 'stub',
    };
    const stub = new StubAdapter('classic', state, { host: 'classic.example' });
    const marks: MarkCall[] = [];
    const calls: string[] = [];
    const p = new Poller(fakeRegistry(stub, marks, calls), liveStore);

    expect(await (p as unknown as Tickable).tick('classic')).toBe('skipped');
    expect(await (p as unknown as Tickable).tick('classic', true)).toBe('skipped'); // even forced
    expect(marks).toEqual([]);
    expect(calls).toEqual([]);
    expect(p.history()).toEqual([]);
  });

  it('does not stamp freshness for a cycle that carried no dataset', async () => {
    const { Poller } = await import('../src/services/poller');
    const adapter = { state: () => ({ linked: true, deviceCount: 3 }), pull: async () => ({}) };
    const marks: MarkCall[] = [];
    const p = new Poller(fakeRegistry(adapter, marks, []), liveStore);

    expect(await (p as unknown as Tickable).tick('mist')).toBe('ok');
    expect(marks[0].ok).toBe(true);
    expect(marks[0].info.stamp).toBe(false); // the plane answered; nothing arrived
    expect(marks[0].info.note).toContain('no dataset');
    expect(p.history()[0].what).toBe('poll ok — no datasets returned');
  });

  it('passes the pull’s unread datasets through and names them in the history', async () => {
    const { Poller } = await import('../src/services/poller');
    const adapter = {
      state: () => ({ linked: true, deviceCount: 1 }),
      pull: async () => ({ devices: [{ name: 'sw-1' }], partial: ['clients'] }),
    };
    const marks: MarkCall[] = [];
    const calls: string[] = [];
    const p = new Poller(fakeRegistry(adapter, marks, calls), liveStore);

    expect(await (p as unknown as Tickable).tick('mist')).toBe('ok');
    // The cycle is history, not vendor traffic: the adapters record the real
    // requests, so no synthetic 'poll()' entry inflates Calls today.
    expect(calls).toEqual([]);
    expect(p.history()[0].what).toContain('devices 1');
    expect(marks[0].info.partial).toEqual(['clients']);
    expect(marks[0].info.stamp).toBe(true);
    expect(p.history()[0].what).toContain('not read: clients');
  });

  it('never attributes a plane’s freshness to a dataset it could not read', async () => {
    const { Poller } = await import('../src/services/poller');
    const synced = '2026-03-01T12:00:00.000Z';
    const { PLANE_IDS } = await import('../src/planes/types');
    const reg = {
      states: () =>
        Object.fromEntries(PLANE_IDS.map((id) => [id, { linked: id === 'mist', lastSync: id === 'mist' ? synced : null }])),
    } as unknown as PlaneRegistry;
    const p = new Poller(reg, liveStore);
    (p as unknown as { contributions: Map<string, unknown> }).contributions.set('mist', {
      devices: [{ name: 'sw-1' }],
      clients: [],
      partial: ['clients'],
    });
    expect(p.lastSyncFor('devices')).toBe(synced);
    expect(p.lastSyncFor('clients')).toBeNull(); // the section was not read
  });

  it('honours the registry backoff for scheduled ticks and ignores it when forced', async () => {
    const { Poller } = await import('../src/services/poller');
    let pulls = 0;
    const state = { linked: true, deviceCount: 0, nextAttemptAt: new Date(Date.now() + 60_000).toISOString() };
    const adapter = {
      state: () => state,
      pull: async () => {
        pulls += 1;
        return { devices: [] };
      },
    };
    const p = new Poller(fakeRegistry(adapter, [], []), liveStore);

    expect(await (p as unknown as Tickable).tick('mist')).toBe('skipped');
    expect(pulls).toBe(0);
    expect(await (p as unknown as Tickable).tick('mist', true)).toBe('ok'); // operator sync
    expect(pulls).toBe(1);
    // Once the window has passed the scheduled cycle resumes on its own.
    state.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
    expect(await (p as unknown as Tickable).tick('mist')).toBe('ok');
    expect(pulls).toBe(2);
  });
});
