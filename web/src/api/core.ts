/**
 * The shared request layer for every API call the UI makes.
 *
 * The rules that make this layer trustworthy live here, in one place, so no
 * individual endpoint can quietly break them:
 *
 *  - An UNREACHABLE backend falls back to fixtures, because a portal that
 *    cannot reach its own server is still useful as a demo.
 *  - An ANSWERED non-OK does NOT fall back. The server replying "I could not
 *    read that" is live information, and substituting fixtures for it would
 *    turn a failure into a plausible-looking screen.
 *  - A detail block the server could not read is DROPPED rather than emptied,
 *    so the screen renders "unread" instead of "nothing there".
 *
 * See "THREE STATES, PRESERVED ACROSS THIS BOUNDARY" below.
 */

import { type WebhookUnknownOutcomeCode } from '@hpe/shared';

// ---------------------------------------------------------------------------
// Response envelopes (per-screen view models + dataSource)
// ---------------------------------------------------------------------------

export type DataSource = 'live' | 'demo';

export interface ScreenEnvelope {
  dataSource: DataSource;
  syncedAt?: string | null;
  blended?: string[];
  /** Present when the backend answered but could not serve the screen. */
  apiError?: string;
}

// -- THREE STATES, PRESERVED ACROSS THIS BOUNDARY ---------------------------
//
// The on-demand detail payloads below (ClientDetailLive, DeviceDetailLive,
// SiteTopologyLive) each carry a `source.sections` map saying what happened to
// every section of the read, because the screens word three outcomes
// differently: never asked / asked and there is genuinely nothing / asked and
// the call failed. A stationary camera with no roams is "no roaming in the
// last 24h", not "no source".
//
// So the rule for every getter here: an ABSENT array stays absent and an EMPTY
// array stays empty. Defaulting a missing array to [] would turn "we never
// asked" into "there are none", which is the exact fabrication this whole pass
// exists to remove. Nothing below applies `?? []` to a detail array.

/** Every detail payload carries a provenance envelope; a body without one
 *  cannot be read three-state. Used the same way getChangeQueue() checks for
 *  an array: a wrong-shaped 200 is an API failure, not an empty result. */
export function carriesDetailSource(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const source = (value as { source?: unknown }).source;
  return (
    !!source &&
    typeof source === 'object' &&
    typeof (source as { plane?: unknown }).plane === 'string' &&
    typeof (source as { sections?: unknown }).sections === 'object'
  );
}

/**
 * Drop an ATTACHED detail block that arrived without its provenance envelope.
 *
 * Such a block is unreadable rather than empty — nothing in it says whether a
 * missing array means "not fetched" or "the call failed" — and a screen that
 * rendered it would have to guess, which is how "—" starts meaning three
 * different things again. Dropping it leaves the panel's existing honest empty
 * state. It is deliberately NOT promoted to an apiError: one unreadable
 * sub-block must not blank a device, site or clients page whose other panels
 * are fine — the honest empty state is the smaller loss.
 */
export function dropUnreadableBlocks<T extends object>(data: T, ...keys: DetailBlockKey[]): T {
  const unreadable = keys.filter((key) => {
    const block = (data as Record<string, unknown>)[key];
    // `null` is the route's own honest "no plane could answer" and is kept.
    return block !== undefined && block !== null && !carriesDetailSource(block);
  });
  if (unreadable.length === 0) return data;
  const copy = { ...data } as Record<string, unknown>;
  for (const key of unreadable) delete copy[key];
  return copy as T;
}

/** The two keys a route attaches a detail payload under. */
export type DetailBlockKey = 'detail' | 'topology';

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export async function fromApi<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SCREEN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
  if (!response.ok) throw new Error(await serverMessage(response, `HTTP ${response.status}`));
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('The portal API returned invalid JSON.');
  }
}

export async function fromStrictOptionalApi<T>(path: string, notFoundIsNull = false): Promise<T | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SCREEN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
  if (notFoundIsNull && response.status === 404) return null;
  if (!response.ok) throw new Error(await serverMessage(response, `HTTP ${response.status}`));
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('The portal API returned invalid JSON.');
  }
}

export type ScreenFetch<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'http-error'; message: string }
  | { kind: 'unreachable' };

export const SCREEN_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Screen endpoints only use fixtures when no backend answered. An HTTP error
 * is an explicit live/API failure and must never turn into believable demo
 * inventory.
 */
export async function fetchScreen<T>(path: string): Promise<ScreenFetch<T>> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SCREEN_REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(path, { signal: controller.signal });
    if (r.ok) {
      try {
        return { kind: 'ok', data: (await r.json()) as T };
      } catch {
        return { kind: 'http-error', message: 'The portal API returned invalid JSON.' };
      }
    }
    return { kind: 'http-error', message: await serverMessage(r, `HTTP ${r.status}`) };
  } catch {
    if (controller.signal.aborted) {
      return { kind: 'http-error', message: 'The portal API did not respond within 15 seconds.' };
    }
    return { kind: 'unreachable' };
  } finally {
    window.clearTimeout(timer);
  }
}

export function apiFailure<T extends ScreenEnvelope>(message: string, empty: Omit<T, keyof ScreenEnvelope>): T {
  return {
    ...empty,
    dataSource: 'live',
    syncedAt: null,
    apiError: message,
  } as T;
}

/**
 * Detail-getter helper: like fromApi, but distinguishes an ANSWERED non-OK
 * (the backend is up and says "not in the live cache" — never substitute
 * fixtures for that) from an unreachable backend (demo fallback allowed).
 */
export async function fetchDetail<T>(
  path: string,
): Promise<
  | { kind: 'ok'; data: T }
  | { kind: 'answered'; status: number; message: string; dataSource?: DataSource; blended?: string[] }
  | { kind: 'unreachable' }
> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SCREEN_REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(path, { signal: controller.signal });
    if (r.ok) {
      try {
        return { kind: 'ok', data: (await r.json()) as T };
      } catch {
        return { kind: 'answered', status: 502, message: 'The portal API returned invalid JSON.' };
      }
    }
    let body: { error?: string; message?: string; dataSource?: DataSource; blended?: string[] } = {};
    try {
      body = (await r.json()) as typeof body;
    } catch {
      /* use the HTTP fallback below */
    }
    return {
      kind: 'answered',
      status: r.status,
      message: body.error ?? body.message ?? `HTTP ${r.status}`,
      dataSource: body.dataSource,
      blended: body.blended,
    };
  } catch {
    if (controller.signal.aborted) {
      return { kind: 'answered', status: 504, message: 'The portal API did not respond within 15 seconds.' };
    }
    return { kind: 'unreachable' };
  } finally {
    window.clearTimeout(timer);
  }
}

/** The stamp the prototype hard-codes in the Overview header. */
export const DEMO_SYNCED_AT = '09:41';

// ---------------------------------------------------------------------------
// On-demand detail reads — the per-object blocks the routes attach to
// /api/clients?mac=…, /api/sites/:siteId and /api/devices/:name
//
// These are NOT poller work. A plane models one client across several
// per-object endpoints and one device across many /{id}/subresource endpoints;
// fanning those out over every row on every 60s tick would spend the tenant's
// daily call budget on data nobody is looking at. Each getter below is for the
// ONE object whose drawer is open, called once per selection.
//
// They return the payload or `null`, never an envelope and never fixtures:
//
//   * `null` = the portal could not obtain a READABLE payload — no backend, a
//     build without the route, an HTTP failure, or a body with no provenance.
//     The panel keeps the honest empty state it already had. It is deliberately
//     NOT an ApiErrorState: these reads are supplementary, and blanking a
//     drawer whose other twenty rows are true would be a worse lie than the
//     missing figure. It is also never fixtures — there is no authored client
//     detail, and inventing one would put fabricated radio numbers against a
//     real endpoint's MAC.
//   * A payload = whatever the plane said, passed through UNTOUCHED. The read
//     that was attempted and failed is not null: the route marks the section
//     'failed' inside `source.sections`, which is how the drawer can say the
//     call broke instead of implying the plane has nothing.
// ---------------------------------------------------------------------------

/**
 * Take the detail payload out of the screen envelope the route attaches it to.
 *
 * Same reasoning as normalizeEvidence() below — one shape for the screen, no
 * guessing at the call site — and it also accepts a route that answers with
 * the bare payload. A block with no provenance envelope is discarded rather
 * than rendered: with no `source.sections` there is no way to tell "asked and
 * empty" from "the call failed", and a figure whose meaning is unknown must
 * not reach an operator.
 */
export function unwrapDetailPayload<T>(body: unknown, key: DetailBlockKey): T | null {
  if (!body || typeof body !== 'object') return null;
  if (carriesDetailSource(body)) return body as T;
  const block = (body as Record<string, unknown>)[key];
  return carriesDetailSource(block) ? (block as T) : null;
}

/** Shared body of the two on-demand reads; see the section note above. */
export async function readDetail<T>(path: string, key: DetailBlockKey): Promise<T | null> {
  const r = await fetchDetail<unknown>(path);
  return r.kind === 'ok' ? unwrapDetailPayload<T>(r.data, key) : null;
}

// ---------------------------------------------------------------------------
// Write broker — /api/configure/* (render / dry-run / queue / push / discard)
//
// The broker is authoritative for queue state whenever the backend is
// reachable. Every mutation returns the server's own message on non-OK
// ({error}) instead of throwing, and marks network failures `offline: true`
// so the Configure screen can fall back to its local-only behavior.
// ---------------------------------------------------------------------------

/** Uniform failure half of ApiResult; `offline` = backend unreachable.
 *  `httpCode` (set only when a real HTTP response came back) lets a caller
 *  distinguish a definite server answer (400/403/409) from a transport-
 *  level 502 "the outcome is unknown" — see isUnknownWebhookOutcome. */
export interface ApiError {
  error: string;
  offline?: boolean;
  httpCode?: number;
  outcome?: 'unknown';
  code?: WebhookUnknownOutcomeCode;
  operationId?: string;
}

export function isApiError(value: unknown): value is ApiError {
  return !!value && typeof value === 'object' && typeof (value as ApiError).error === 'string';
}

export type ApiResult<T> = T | ApiError;

export async function postForResult<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return (await r.json()) as T;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`) };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export function responseJson(r: Response): Promise<unknown> {
  return r.json().catch(() => undefined);
}

export function messageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
  if (typeof record.message === 'string') return record.message;
  return fallback;
}

/** Read the server's message out of a non-OK response ({error} or {message}). */
export async function serverMessage(r: Response, fallback: string): Promise<string> {
  try {
    const body = (await r.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}
