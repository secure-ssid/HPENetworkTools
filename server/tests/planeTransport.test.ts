/**
 * Tests for the plane transport primitives.
 *
 * These moved here from central.test.ts along with the code. TokenManager and
 * the rate-limit header readers are used by six adapters; testing them under a
 * file named for one of those adapters implied Central owned them.
 */

import { describe, expect, it } from 'vitest';
import {
  TokenManager,
  mintedTokenInfo,
  parseRateLimitResetAtMs,
  parseRetryAfterMs,
  realSleep,
} from '../src/planes/transport';

describe('TokenManager', () => {
  function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let t = start;
    return { now: () => t, advance: (ms) => (t += ms) };
  }

  it('caches the token until expiry minus the 60s margin', async () => {
    const clk = clock();
    let fetches = 0;
    const tm = new TokenManager(async () => {
      fetches += 1;
      return { accessToken: `tok-${fetches}`, expiresInSec: 3600 };
    }, clk.now);

    expect(await tm.get()).toBe('tok-1');
    clk.advance(3_539_000); // just inside the validity window
    expect(await tm.get()).toBe('tok-1');
    expect(fetches).toBe(1);

    clk.advance(2_000); // now past expiry − 60s
    expect(await tm.get()).toBe('tok-2');
    expect(fetches).toBe(2);
  });

  it('single-flight: concurrent get() calls share one token fetch', async () => {
    let fetches = 0;
    let release!: (t: { accessToken: string; expiresInSec: number }) => void;
    const tm = new TokenManager(
      () =>
        new Promise((resolve) => {
          fetches += 1;
          release = resolve;
        }),
      clock().now,
    );
    const a = tm.get();
    const b = tm.get();
    const c = tm.get();
    release({ accessToken: 'shared', expiresInSec: 7200 });
    expect(await Promise.all([a, b, c])).toEqual(['shared', 'shared', 'shared']);
    expect(fetches).toBe(1);
  });

  it('a failed fetch does not poison the manager — the next get() retries', async () => {
    let fetches = 0;
    const tm = new TokenManager(async () => {
      fetches += 1;
      if (fetches === 1) throw new Error('gateway unreachable');
      return { accessToken: 'recovered', expiresInSec: 3600 };
    }, clock().now);
    await expect(tm.get()).rejects.toThrow('gateway unreachable');
    expect(await tm.get()).toBe('recovered');
    expect(fetches).toBe(2);
  });

  it('invalidate() forces a re-authentication', async () => {
    let fetches = 0;
    const tm = new TokenManager(async () => ({ accessToken: `tok-${++fetches}`, expiresInSec: 3600 }), clock().now);
    expect(await tm.get()).toBe('tok-1');
    tm.invalidate();
    expect(await tm.get()).toBe('tok-2');
  });

  it('never caches a token shorter than the refresh margin', async () => {
    const clk = clock();
    let fetches = 0;
    const tm = new TokenManager(async () => ({ accessToken: `tok-${++fetches}`, expiresInSec: 30 }), clk.now);
    await tm.get();
    expect(await tm.get()).toBe('tok-2'); // 30s < 60s margin → no caching
  });
});

describe('rate-limit headers', () => {
  it('parseRetryAfterMs reads both Retry-After forms and rejects junk', () => {
    const now = 1_753_000_000_000;
    expect(parseRetryAfterMs('30', now)).toBe(30_000); // delta-seconds
    expect(parseRetryAfterMs('  5 ', now)).toBe(5_000);
    expect(parseRetryAfterMs(new Date(now + 12_000).toUTCString(), now)).toBe(12_000); // HTTP-date
    expect(parseRetryAfterMs(new Date(now - 12_000).toUTCString(), now)).toBe(0); // never negative
    expect(parseRetryAfterMs('soon', now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });

  it('parseRateLimitResetAtMs reads epoch, delta, and date forms', () => {
    const now = 1_753_000_000_000;
    expect(parseRateLimitResetAtMs(String((now + 12_000) / 1000), now)).toBe(now + 12_000);
    expect(parseRateLimitResetAtMs(String(now + 8_000), now)).toBe(now + 8_000);
    expect(parseRateLimitResetAtMs('5', now)).toBe(now + 5_000);
    expect(parseRateLimitResetAtMs(new Date(now + 4_000).toUTCString(), now)).toBe(now + 4_000);
    expect(parseRateLimitResetAtMs('soon', now)).toBeNull();
  });
});

describe('mintedTokenInfo', () => {
  const now = 1_753_000_000_000;

  it('publishes the plane-stated expiry, not the manager refresh margin', () => {
    // 3600s TTL: the fact operators see is when the CREDENTIAL dies, which is
    // an hour away — not the 3540s point where this process chooses to refresh.
    expect(mintedTokenInfo(3600, 'oauth client_credentials', now)).toEqual({
      expiresAt: new Date(now + 3_600_000).toISOString(),
      source: 'oauth client_credentials',
    });
  });

  it('says null rather than inventing a lifetime the plane never published', () => {
    for (const ttl of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mintedTokenInfo(ttl, 'static token', now).expiresAt).toBeNull();
    }
  });

  it('keeps the source label so the fact strip can name where the token came from', () => {
    expect(mintedTokenInfo(60, 'cppm oauth', now).source).toBe('cppm oauth');
    expect(mintedTokenInfo(60, undefined, now).source).toBe('oauth client_credentials');
  });
});

describe('realSleep', () => {
  it('resolves after the requested delay', async () => {
    const started = Date.now();
    await realSleep(10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(8);
  });
});
