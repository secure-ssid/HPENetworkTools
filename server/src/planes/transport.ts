/**
 * Plane transport primitives.
 *
 * Every plane adapter needs the same handful of mechanisms: a way to make an
 * HTTP call it can substitute in tests, a way to sleep it can substitute in
 * tests, a way to report what a call cost, a cached bearer token that refreshes
 * itself, and a way to read the two rate-limit headers vendors actually send.
 * All seven adapters had these. Six of them got them by importing from
 * central.ts — the largest adapter in the tree — because that is where they
 * happened to be written first. That made HPE Central a dependency of Mist,
 * UXI, ClearPass, GreenLake, SSE and AOS-8, which is not a relationship any of
 * those planes has in reality.
 *
 * They live here instead. Nothing in this file knows which plane is calling it.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: the retry loops.
 *
 * It is tempting to finish the job and hoist "retry a 429 with exponential
 * backoff" up here too, since six adapters have a loop that looks alike. They
 * only look alike. The differences are load-bearing and were each chosen for a
 * stated reason:
 *
 *   - GreenLake never retries a WRITE on 429 or on a network error. A retried
 *     create is how you get a duplicate device or a double-consumed
 *     subscription key. Only the 401 refresh path retries.
 *   - ClearPass also treats 502/503/504 as transient, because CPPM's gateway
 *     sheds load that way; elsewhere a 5xx is final.
 *   - UXI retries a 429 exactly once and caps the wait, because its retry
 *     budget belongs to a poll tick that must not stall.
 *   - Central's detail reads skip the backoff loop entirely so one rate-limited
 *     row degrades to a gap instead of stalling the whole pull.
 *   - AOS-8 has no 429 concept at all; it invalidates a session on 401/403.
 *
 * A shared loop would have to be parameterised into something that encodes all
 * five policies, and the first person to add a sixth plane would reach for the
 * closest-looking preset rather than deciding what their plane needs. The cost
 * of the duplication is a few similar loops; the cost of unifying it is a
 * duplicate device order. The loops stay with the adapters that own the policy.
 */

import type { PlaneTokenInfo } from './types';

/** What a completed call cost, for the Activity tab. `code` is the HTTP status
 *  as a string, or a short label like 'timeout' when there was no response. */
export type RecordCallFn = (call: { path: string; ms: number; code: string }) => void;

/** The fetch surface an adapter is given. Injectable so tests answer without a
 *  network, and so TLS-verification choices stay with the adapter. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Injectable so tests exercise pacing and backoff without real wall time. */
export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Defensive field readers
// ---------------------------------------------------------------------------
// Vendors send numbers as strings, strings padded with whitespace, and absent
// values as '', null or a missing key interchangeably. Both readers answer null
// rather than guessing, so a caller can tell "not provided" from "provided as
// zero" — which matters for a Retry-After of 0.

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0 && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

// ---------------------------------------------------------------------------
// Bearer tokens
// ---------------------------------------------------------------------------

export interface TokenResponse {
  accessToken: string;
  expiresInSec: number;
}

/**
 * A cached bearer token that refreshes itself shortly before it expires.
 *
 * The refresh margin exists because a token that is valid when we check it can
 * still be expired when the plane reads it — the call has to cross a network.
 * Refreshing at expiry − 60s makes that race lose.
 *
 * Concurrent callers share a single in-flight mint (`inflight`). Without that,
 * a pull that fans out to eight sections on a cold cache mints eight tokens,
 * and planes that invalidate the previous token on mint would hand seven of
 * those calls a token that was already dead.
 */
export class TokenManager {
  private token: string | null = null;
  private validUntilMs = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly fetchToken: () => Promise<TokenResponse>,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly refreshMarginSec = 60,
  ) {}

  /** Cached bearer token; refreshes at expiry − margin. Concurrent callers share one fetch. */
  async get(): Promise<string> {
    if (this.token !== null && this.nowMs() < this.validUntilMs) return this.token;
    this.inflight ??= this.fetchToken()
      .then(({ accessToken, expiresInSec }) => {
        this.token = accessToken;
        const ttlSec = Math.max(0, expiresInSec - this.refreshMarginSec);
        this.validUntilMs = this.nowMs() + ttlSec * 1000;
        return accessToken;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Drop the cached token (after a 401) so the next get() re-authenticates. */
  invalidate(): void {
    this.token = null;
    this.validUntilMs = 0;
  }
}

/**
 * The credential-freshness fact for a token that was just minted: the REAL
 * expiry the plane published (not the manager's earlier refresh point, which is
 * an internal margin) plus a source label, so the Systems fact strip can read
 * 'rotates 12 Aug' instead of 'no expiry published'. The registry seeds
 * PlaneState.token with the source alone — only the adapter's token manager
 * ever learns when the credential dies, so only it can fill the expiry in.
 *
 * SECURITY: expiry + label ONLY. /api/systems/state serves PlaneState unmasked,
 * so the token itself (or any fragment of it) must never reach this struct.
 * A plane that publishes no `expires_in` keeps `expiresAt: null` rather than
 * having a lifetime invented for it.
 */
export function mintedTokenInfo(
  expiresInSec: number | null,
  source = 'oauth client_credentials',
  nowMs: number = Date.now(),
): PlaneTokenInfo {
  const ttl = expiresInSec !== null && Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : null;
  return { expiresAt: ttl === null ? null : new Date(nowMs + ttl * 1000).toISOString(), source };
}

// ---------------------------------------------------------------------------
// Rate-limit headers
// ---------------------------------------------------------------------------

/** Retry-After is delta-seconds or an HTTP-date; both → ms, anything else null. */
export function parseRetryAfterMs(header: string | null, nowMs: number = Date.now()): number | null {
  const raw = str(header);
  if (!raw) return null;
  const secs = num(raw);
  if (secs !== null) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** X-RateLimit-Reset is normally epoch seconds; tolerate epoch ms, delta
 * seconds, and an HTTP date without ever scheduling in the past. */
export function parseRateLimitResetAtMs(header: string | null, nowMs: number = Date.now()): number | null {
  const raw = str(header);
  if (!raw) return null;
  const value = num(raw);
  if (value !== null) {
    const at = value >= 1e12 ? value : value >= 1e9 ? value * 1000 : nowMs + value * 1000;
    return Math.max(nowMs, at);
  }
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(nowMs, at);
}
