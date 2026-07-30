/**
 * server/tests/detailCache.test.ts — how long a detail read is allowed to be
 * believed.
 *
 * attemptDetail deliberately resolves a throw or a timeout into a "failed"
 * payload, so a screen can say what went wrong instead of pretending there was
 * nothing to show. That makes the failure look, to the cache, exactly like a
 * successful read — and a cache is a machine for repeating things. The whole
 * point of these tests is that a fault and an answer must not be repeated for
 * the same length of time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DETAIL_FAILURE_TTL_MS,
  DETAIL_TTL_MS,
  attemptDetail,
  cachedDetail,
  isFailedRead,
  resetDetailCache,
} from '../src/routes/screens/detailCache';

interface Payload {
  id: string;
  source: {
    plane: 'central';
    at: string;
    sections: Record<string, string>;
    note?: string;
    cached?: boolean;
  };
}

function ok(id: string): Payload {
  return { id, source: { plane: 'central', at: '2024-01-01T00:00:00Z', sections: { ports: 'ok' } } };
}

function failed(note: string): Payload {
  return { id: 'stub', source: { plane: 'central', at: '2024-01-01T00:00:00Z', sections: { ports: 'failed' }, note } };
}

let now = 1_700_000_000_000;

beforeEach(() => {
  resetDetailCache();
  now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDetailCache();
});

describe('isFailedRead', () => {
  it('recognises a payload carrying a failed section', () => {
    expect(isFailedRead(failed('boom'))).toBe(true);
    expect(isFailedRead(ok('a'))).toBe(false);
  });

  it('treats null as not-a-failure, because null means no plane can answer at all', () => {
    // That is a structural fact rather than a transient fault, and the cache
    // is meant to hold on to it.
    expect(isFailedRead(null)).toBe(false);
    expect(isFailedRead(undefined)).toBe(false);
    expect(isFailedRead({})).toBe(false);
  });
});

describe('cachedDetail', () => {
  it('serves a successful read from cache for the full TTL', async () => {
    const run = vi.fn().mockResolvedValue(ok('a'));
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);
    now += DETAIL_TTL_MS - 1;
    const second = await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(second?.source.cached).toBe(true);
  });

  it('stops repeating a failed read long before the success TTL is up', async () => {
    const run = vi.fn().mockResolvedValue(failed('the detail read did not answer within 10s'));
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);

    // Well inside the 90s success TTL. Without a shorter failure TTL the
    // operator would be handed this same fault for another minute and a half,
    // with nothing retried in between.
    now += DETAIL_FAILURE_TTL_MS + 1;
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);

    expect(run).toHaveBeenCalledTimes(2);
    expect(DETAIL_FAILURE_TTL_MS).toBeLessThan(DETAIL_TTL_MS);
  });

  it('still absorbs a burst while the plane is down', async () => {
    // Retrying every request would be the stampede the cache exists to stop.
    const run = vi.fn().mockResolvedValue(failed('boom'));
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);
    now += DETAIL_FAILURE_TTL_MS - 1;
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('shows the plane recovered once the failure has aged out', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(failed('boom'))
      .mockResolvedValueOnce(ok('recovered'));

    const first = await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);
    expect(first?.source.sections.ports).toBe('failed');

    now += DETAIL_FAILURE_TTL_MS + 1;
    const second = await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);
    expect(second?.id).toBe('recovered');

    // And the recovery is then held for the full success TTL again.
    now += DETAIL_FAILURE_TTL_MS + 1;
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps a cached null for the full TTL', async () => {
    const run = vi.fn().mockResolvedValue(null);
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);
    now += DETAIL_FAILURE_TTL_MS + 1;
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('caches what attemptDetail makes of a throwing adapter, then retries it promptly', async () => {
    const adapter = vi.fn().mockRejectedValue(new Error('central said no'));
    const run = () => attemptDetail<Payload>(adapter, (note) => failed(note));

    const first = await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);
    expect(first?.source.sections.ports).toBe('failed');
    expect(adapter).toHaveBeenCalledTimes(1);

    now += DETAIL_FAILURE_TTL_MS + 1;
    await cachedDetail<Payload>('k', DETAIL_TTL_MS, run);
    expect(adapter).toHaveBeenCalledTimes(2);
  });
});
