/**
 * Shared route helpers used by more than one screens/* module.
 * Keep this file free of route registration so concurrent extracts can import
 * without merge-fighting on domain routers.
 */

import type { TrendWindow } from '@hpe/shared';

/** Default on-demand trend/applications window: last 24h ending at request time. */
export const DEFAULT_TREND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The window a request asked for, or the 24h default. Present bounds pass
 * through verbatim: the adapter's own validation words a bad one, which is
 * more honest than silently substituting the default.
 *
 * Shared by site applications and device hardware/AP/interface trends.
 */
export function trendWindow(query: { start?: unknown; end?: unknown }): TrendWindow {
  const start = typeof query.start === 'string' ? query.start : undefined;
  const end = typeof query.end === 'string' ? query.end : undefined;
  if (start !== undefined || end !== undefined) return { start: start ?? '', end: end ?? '' };
  const endMs = Date.now();
  return {
    start: new Date(endMs - DEFAULT_TREND_WINDOW_MS).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

/** Alias kept for call sites that still speak in applications terms. */
export const applicationsWindow = trendWindow;
