/** Auth events screen: window stats, failure reasons and policy services. */

import { LiveAuthEvent } from './liveCore';
import {
  type FailReasonRow,
  type PolicyServiceRow,
  type StatDef,
  countOf,
  formatCount,
} from '@hpe/shared';

/** Window covered by the event feed (0 when timestamps are absent/identical). */
export function eventWindowMs(events: LiveAuthEvent[]): number {
  const stamps = events.map((e) => e.tsMs).filter((t): t is number => t !== undefined);
  return stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : 0;
}

/**
 * The five auth Stats. Two honesty rules run through them:
 *  - No feed at all is not a quiet network. An empty event list means no
 *    policy plane answered for this window, so every tile reads '—' rather
 *    than a green zero-reject scorecard.
 *  - A rate needs a measured window. When no row carries a parseable
 *    timestamp the span is unknown, and dividing by a floor of one minute
 *    invents a per-minute rate the portal never observed.
 */
export function liveAuthStats(events: LiveAuthEvent[]): StatDef[] {
  const total = events.length;
  if (total === 0) {
    return [
      { label: 'Auths / min', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
      { label: 'Accept rate', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
      { label: 'Rejects / hour', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
      { label: 'MAB fallbacks', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
      { label: 'Known endpoints', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
    ];
  }
  const accepts = events.filter((e) => e.result === 'accept').length;
  const rejects = events.filter((e) => e.result === 'reject').length;
  const mab = events.filter((e) => e.method === 'MAB').length;
  const endpoints = new Set(events.map((e) => e.mac).filter((m) => m !== '—')).size;
  const spanMs = eventWindowMs(events);
  const spanKnown = spanMs > 0;
  const spanMin = Math.max(spanMs / 60_000, 1);
  const acceptRate = total > 0 ? (accepts / total) * 100 : null;
  return [
    {
      label: 'Auths / min',
      value: spanKnown ? formatCount(Math.round(total / spanMin)) : '—',
      delta: spanKnown
        ? `${countOf(total, 'event')} in a ${formatCount(Math.round(spanMin))} min window`
        : `${countOf(total, 'event')} · feed carries no timestamps`,
      tone: 'neutral',
    },
    {
      label: 'Accept rate',
      value: acceptRate === null ? '—' : `${acceptRate.toFixed(1)}%`,
      delta: `${formatCount(accepts)} of ${formatCount(total)} accepted`,
      tone: acceptRate === null ? 'neutral' : acceptRate >= 95 ? 'positive' : acceptRate >= 85 ? 'neutral' : 'negative',
    },
    {
      label: 'Rejects / hour',
      value: spanKnown ? formatCount(Math.round(rejects / Math.max(spanMs / 3_600_000, 1 / 60))) : '—',
      delta: spanKnown
        ? `${countOf(rejects, 'reject')} in window`
        : `${countOf(rejects, 'reject')} · feed carries no timestamps`,
      tone: rejects > 0 ? 'negative' : spanKnown ? 'positive' : 'neutral',
    },
    {
      label: 'MAB fallbacks',
      value: formatCount(mab),
      delta: total > 0 ? `${Math.round((mab / total) * 100)}% of auths` : 'no events',
      tone: 'neutral',
    },
    { label: 'Known endpoints', value: formatCount(endpoints), delta: 'distinct MACs in window', tone: 'neutral' },
  ];
}

/** "Why authentications failed" — top reject reasons, top 5 like the fixtures. */
export function liveFailReasons(events: LiveAuthEvent[]): FailReasonRow[] {
  const byReason = new Map<string, { count: number; macs: Set<string> }>();
  for (const e of events) {
    if (e.result !== 'reject') continue;
    const label = e.reason && e.reason !== '—' ? e.reason : 'No reason given';
    const entry = byReason.get(label) ?? { count: 0, macs: new Set<string>() };
    entry.count += 1;
    if (e.mac !== '—') entry.macs.add(e.mac);
    byReason.set(label, entry);
  }
  return [...byReason.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([label, { count, macs }]) => ({
      label,
      value: count,
      note: `${countOf(count, 'event')} · ${countOf(macs.size, 'endpoint')}`,
    }));
}

/**
 * "Policy services" — per-service auth counts from the feed. State cannot be
 * asserted from logs alone, so a service is 'ok' unless rejects dominate the
 * window, in which case it is honestly 'noisy'.
 */
export function livePolicyServices(events: LiveAuthEvent[]): PolicyServiceRow[] {
  const spanHr = Math.max(eventWindowMs(events) / 3_600_000, 1 / 60);
  const byService = new Map<string, { count: number; rejects: number; methods: Set<string> }>();
  for (const e of events) {
    const name = e.service && e.service !== '—' ? e.service : 'Unknown service';
    const entry = byService.get(name) ?? { count: 0, rejects: 0, methods: new Set<string>() };
    entry.count += 1;
    if (e.result === 'reject') entry.rejects += 1;
    if (e.method !== '—') entry.methods.add(e.method);
    byService.set(name, entry);
  }

  return [...byService.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, { count, rejects, methods }]) => {
      const noisy = count > 0 && rejects / count > 0.25;
      return {
        name,
        detail: [...methods].join(' · ') || '—',
        rate: formatCount(Math.round(count / spanHr)),
        state: noisy ? 'noisy' : 'ok',
        tone: noisy ? ('warning' as const) : ('success' as const),
      };
    });
}
