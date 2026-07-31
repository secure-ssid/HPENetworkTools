/**
 * Tests for the plane transport primitives.
 *
 * These moved here from central.test.ts along with the code. TokenManager and
 * the rate-limit header readers are used by six adapters; testing them under a
 * file named for one of those adapters implied Central owned them.
 */

import { describe, expect, it } from 'vitest';
import {
  httpsBase,
  normaliseBaseUrlUnchecked,
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

/* Five of the six copies of this normalisation accepted `http://` and said
 * nothing. Every plane here authenticates — a client secret posted to mint a
 * token, a bearer or API token on every call, a password on a login form — so
 * an http:// base URL put all of it on the wire in the clear, from a portal
 * that masks those same secrets in its logs and its settings reads. Only
 * AOS-8's copy refused, and its reasoning applied to all of them. */
describe('httpsBase', () => {
  const WHAT = 'the client secret is posted to mint a token';

  it('assumes https for a bare host — the operator typed a hostname, not a scheme', () => {
    expect(httpsBase('apigw-prod2.central.arubanetworks.com', WHAT)).toBe(
      'https://apigw-prod2.central.arubanetworks.com',
    );
    expect(httpsBase('  10.48.0.10:4343  ', WHAT)).toBe('https://10.48.0.10:4343');
  });

  it('passes an https base through untouched, whatever its case', () => {
    expect(httpsBase('https://a.example/api', WHAT)).toBe('https://a.example/api');
    expect(httpsBase('HTTPS://a.example', WHAT)).toBe('HTTPS://a.example');
  });

  it('refuses a routable http base and names the credential that would leak', () => {
    expect(() => httpsBase('http://10.48.0.10:4343', WHAT)).toThrow(/must use https/);
    // The message has to say what is at stake, not cite a rule: an operator
    // who typed http:// needs to know a secret was about to cross the network.
    expect(() => httpsBase('http://cppm.example.com', WHAT)).toThrow(
      /the client secret is posted to mint a token/,
    );
    expect(() => httpsBase('http://cppm.example.com', WHAT)).toThrow(/cleartext/);
  });

  it('refuses any other scheme outright, loopback or not', () => {
    for (const base of ['ftp://10.0.0.1', 'ws://10.0.0.1', 'file://x', 'ftp://127.0.0.1', 'ws://localhost']) {
      expect(() => httpsBase(base, WHAT)).toThrow(/must use https/);
    }
  });

  /* Plaintext to loopback is the one exception and it is not a concession:
     the packet never reaches a network interface, so there is nothing on the
     path to read it. Same line browsers draw for http://localhost. */
  it('allows http only to loopback, where no network carries the secret', () => {
    for (const base of ['http://127.0.0.1:1', 'http://localhost:8080', 'http://[::1]:9000', 'http://127.9.9.9']) {
      expect(httpsBase(base, WHAT)).toBe(base);
    }
  });

  it('is not fooled by a hostname that merely starts with localhost', () => {
    for (const base of ['http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'http://notlocalhost']) {
      expect(() => httpsBase(base, WHAT)).toThrow(/must use https/);
    }
  });

  it('refuses a base it cannot parse rather than assuming it is harmless', () => {
    expect(() => httpsBase('http://[oops', WHAT)).toThrow(/must use https/);
  });
});

/* The validating and non-validating forms are spelled differently on purpose.
 * This module already has one name covering two contracts — extractTotal —
 * and a caller that reached for the wrong one reported a page size as a
 * window total. */
describe('normaliseBaseUrlUnchecked', () => {
  it('normalises without judging, for callers that send no credential', () => {
    expect(normaliseBaseUrlUnchecked('a.example')).toBe('https://a.example');
    expect(normaliseBaseUrlUnchecked('  http://a.example  ')).toBe('http://a.example');
    expect(normaliseBaseUrlUnchecked('https://a.example')).toBe('https://a.example');
  });
});
