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
import type { DetailFetchState } from '@hpe/shared';
import { detailState } from '@hpe/shared';
import {
  DETAIL_FAILURE_TTL_MS,
  DETAIL_TTL_MS,
  attemptDetail,
  cachedDetail,
  isFailedRead,
  resetDetailCache,
  topologyStub,
} from '../src/routes/screens/detailCache';

interface Payload {
  id: string;
  source: {
    plane: 'central';
    at: string;
    sections: Partial<Record<string, DetailFetchState>>;
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

/**
 * The stub is the only record that a topology read went wrong.
 *
 * Callers that want an edge list read `topology.links` and get nothing back
 * from a stub, which is indistinguishable from a site with no neighbours --
 * so the reason has to survive somewhere else, and `source.sections` is it.
 * The estate graph's "could not be read" caption is derived from exactly this,
 * so if a stub ever starts claiming a state it did not reach, the caption goes
 * quiet at the moment it is most needed.
 */
describe('topologyStub — a failed read must not read as an empty site', () => {
  it('marks an attempted read that broke as failed, not empty', () => {
    const stub = topologyStub('site-1', 'central', 'topology: HTTP 503', true);
    expect(detailState(stub.source, 'links')).toBe('failed');
    expect(detailState(stub.source, 'nodes')).toBe('failed');
    // 'empty' is the word Central uses when it answers and the site has none.
    expect(detailState(stub.source, 'links')).not.toBe('empty');
    expect(stub.source.note).toBe('topology: HTTP 503');
  });

  it('marks a read the budget refused as never attempted', () => {
    const stub = topologyStub('site-1', 'central', 'detail budget spent', false);
    expect(detailState(stub.source, 'links')).toBe('not-fetched');
    expect(stub.source.note).toBe('detail budget spent');
  });

  it('carries no links array either way, so no caller can mistake one for []', () => {
    for (const attempted of [true, false]) {
      const stub = topologyStub('site-1', 'central', 'note', attempted);
      expect(stub.links).toBeUndefined();
      expect(stub.nodes).toBeUndefined();
    }
  });
});
