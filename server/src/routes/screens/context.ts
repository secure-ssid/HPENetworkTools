/**
 * Screen envelope and data-source context.
 *
 * Every /api/screens response is an envelope stating where its payload came
 * from and how fresh it is. That contract is the load-bearing part of the
 * honesty rules: a screen may show fixtures, or live rows, or fixtures with
 * live rows blended in, and the operator has to be able to tell which without
 * guessing. These helpers are the only place that decision is made, so no
 * individual screen can quietly stamp a payload with a freshness it does not
 * have.
 */

import {
  effectiveSectionSource,
  settings,
} from '../../config/settings';
import { registry } from '../../planes/registry';
import {
  PLANE_IDS,
  type PlaneId,
  type PlanePull,
} from '../../planes/types';
import { poller } from '../../services/poller';
import { planeIdForLabel } from '../../services/reconcile';
import {
  SITE_IDS,
  type Plane,
  type ScreenSection,
  type SiteId,
} from '@hpe/shared';

export type DataSource = 'demo' | 'live';

export function dataSource(): DataSource {
  return settings.get().demoMode ? 'demo' : 'live';
}

/** Effective source for one screen section: its override, else portal demoMode. */
export function sourceFor(section: ScreenSection): DataSource {
  return effectiveSectionSource(settings.get(), section);
}

/**
 * Blend mode (blendLive on): a demo-sourced section swaps to real poller rows
 * as soon as any plane reports them; sections without live rows stay on
 * fixtures. Real and fixture rows never mix inside one section, and the
 * envelope's `blended` list names the swapped sections so the UI can badge
 * them honestly.
 */
export function blending(): boolean {
  return settings.get().blendLive === true;
}

/**
 * Blend for one section: the global flag, unless the operator pinned that
 * section to demo explicitly — a 'demo' pin must win over the swap, or the
 * UI's "pinned to demo" toast would lie.
 */
export function blendFor(section: ScreenSection): boolean {
  return blending() && settings.get().sectionMode?.[section] !== 'demo';
}

/** Pick live rows over fixtures when blending and the section has live data. */
export function blendSection<T>(section: string, liveRows: readonly T[], fixture: T[], bag: string[]): T[] {
  if (liveRows.length > 0) {
    bag.push(section);
    return [...liveRows];
  }
  return fixture;
}

/**
 * Attach the blended-section list to an envelope payload (omit when empty).
 *
 * A blended envelope keeps `dataSource: 'demo'` — the screen is still a demo
 * screen — but its freshness stamp must be the POLL time of the rows it is
 * actually serving. envelopeFor() stamps `now` for a demo source, which is
 * true of fixtures and a lie about a live row last fetched hours ago (design
 * rule 1). Callers that know their section pass it so the stamp can be fixed.
 */
export function withBlended(
  payload: Record<string, unknown>,
  blended: string[],
  section?: ScreenSection,
): Record<string, unknown> {
  if (blended.length === 0) return payload;
  const stamped = { ...payload, blended };
  return section === undefined ? stamped : { ...stamped, syncedAt: syncedAtFor(section) };
}

export function syncedAt(): string | null {
  return dataSource() === 'demo' ? new Date().toISOString() : poller.lastSyncAny();
}

export function syncedAtFor(section: ScreenSection): string | null {
  switch (section) {
    case 'overview':
      return poller.lastSyncFor('devices', 'sites', 'alerts');
    case 'alerts':
      return poller.lastSyncFor('alerts');
    case 'clients':
      return poller.lastSyncFor('clients');
    case 'authEvents':
      return poller.lastSyncFor('authEvents');
    case 'sites':
      return poller.lastSyncFor('sites', 'devices');
    case 'devices':
      return poller.lastSyncFor('devices');
    case 'licenses':
      return poller.lastSyncFor('subscriptions');
    case 'systems':
      return poller.lastSyncAny();
    // Both are derived from live rows (observed inventory / evidence
    // coverage), so they carry the freshness of the datasets they read.
    case 'configure':
      return poller.lastSyncFor('clients');
    case 'compliance':
      return poller.lastSyncFor('devices');
  }
}

export function envelope(extra: Record<string, unknown>): Record<string, unknown> {
  return { dataSource: dataSource(), syncedAt: syncedAt(), ...extra };
}

/** Envelope stamped with a section's EFFECTIVE source (its override, if any). */
export function envelopeFor(section: ScreenSection, extra: Record<string, unknown>): Record<string, unknown> {
  const source = sourceFor(section);
  return {
    dataSource: source,
    syncedAt: source === 'demo' ? new Date().toISOString() : syncedAtFor(section),
    ...extra,
  };
}

export function isSiteId(value: string): value is SiteId {
  return (SITE_IDS as readonly string[]).includes(value);
}

/**
 * Planes serving last-good data — "stale" for reconcile. Reading
 * `health === 'degraded'` alone only ever caught a poll that THREW; the
 * registry's shared age-based flag (shared/logic.ts planeStaleness) also
 * covers the plane that quietly stopped updating ('aged-out') and the pull
 * that came back half-read ('partial'), both of which serve rows that must
 * render 'unverified' rather than 'up' (design rule 1).
 *
 * 'never-synced' is deliberately NOT stale here: a plane that has never
 * answered contributes no rows to mark, so the flag would only ever downgrade
 * rows that reached the cache by some other path.
 */
export function stalePlanes(): Set<PlaneId> {
  const out = new Set<PlaneId>();
  for (const id of PLANE_IDS) {
    const s = registry.state(id);
    if (s.health === 'degraded' || (s.stale && s.reason !== 'never-synced')) out.add(id);
  }
  return out;
}

/** True when the plane behind this display label is currently serving stale
 *  data (design rule 1). Labels with no registry plane are never asserted —
 *  planeIdForLabel() resolves 'THIRD-PARTY' to undefined, so such a label
 *  never claims a freshness stamp it cannot have. */
export function planeIsStale(plane: Plane, stale: ReadonlySet<PlaneId>): boolean {
  const id = planeIdForLabel(plane);
  return id !== undefined && stale.has(id);
}

export function datasetReported(key: keyof PlanePull): boolean {
  for (const [, pull] of poller.contributionsByPlane()) {
    if (pull[key] !== undefined) return true;
  }
  return false;
}

export function reportedValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const normal = value.trim().toLowerCase();
  return normal !== '—' && normal !== 'unknown' && normal !== 'not reported';
}

export function displayParts(parts: Array<string | null | undefined>): string {
  const values = parts.filter((part): part is string => reportedValue(part));
  return values.length > 0 ? values.join(' · ') : 'Not reported';
}
