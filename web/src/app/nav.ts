/**
 * web/src/app/nav.ts — view ⇄ path mapping shared by the shell and search.
 *
 * Routes carry the entity in the URL: /sites/:siteId, /devices/:name.
 * The 'auth' view lives at /auth-events; the drill-down views 'site' and
 * 'device' only exist as /sites/:siteId and /devices/:name.
 */

import { siteIdFor } from '@hpe/shared';
import type { Plane, SearchIndexEntry, View } from '@hpe/shared';

/** Current shell view for a pathname (drill-downs → 'site' | 'device'). */
export function viewForPath(pathname: string): View | null {
  const seg = pathname.split('/').filter(Boolean);
  switch (seg[0]) {
    case undefined:
    case 'overview':
      return 'overview';
    case 'alerts':
      return 'alerts';
    case 'tickets':
      return 'tickets';
    case 'clients':
      return 'clients';
    case 'auth-events':
      return 'auth';
    case 'inventory':
      return 'inventory';
    case 'sites':
      return seg[1] ? 'site' : 'sites';
    case 'devices':
      return seg[1] ? 'device' : 'devices';
    case 'licenses':
      return 'licenses';
    case 'configure':
      return 'configure';
    case 'compliance':
      return 'compliance';
    case 'systems':
      return 'systems';
    default:
      return null;
  }
}

/** Canonical path for a nav view (drill-down views resolve to their list). */
export function pathForView(view: View): string {
  switch (view) {
    case 'auth':
      return '/auth-events';
    case 'site':
      return '/sites';
    case 'device':
      return '/devices';
    default:
      return `/${view}`;
  }
}

/**
 * Where a search hit goes, driven uniformly by `view` + `arg` (never by
 * `kind` — the prototype's Enter handler branched on kind and mis-routed
 * mac/ip/config hits; do not reintroduce that):
 *   site hits   → /sites/:siteId   (arg = authored site name, resolved to id)
 *   device hits → /devices/:name   (also mac/ip kinds, whose view is 'device')
 *   client hits → /clients?mac=<arg> when the hit carries one
 *   ticket hits → /tickets?sel=<arg> when the hit carries one
 *   everything else → /<view>
 */export function pathForSearchHit(r: SearchIndexEntry): string {
  switch (r.view) {
    case 'site': {
      const id = r.arg ? siteIdFor(r.arg) : undefined;
      return `/sites/${encodeURIComponent(id ?? r.arg ?? '')}`;
    }
    case 'device':
      return `/devices/${encodeURIComponent(r.arg ?? '')}`;
    case 'clients':
      return r.arg ? `/clients?mac=${encodeURIComponent(r.arg)}` : '/clients';
    case 'tickets':
      return r.arg ? `/tickets?sel=${encodeURIComponent(r.arg)}` : '/tickets';
    default:
      return pathForView(r.view);
  }
}

/**
 * Identity a device-row link can carry — mirrors the plane+serial pair
 * DiagnosticsPanel already keys on (web/src/components/DiagnosticsPanel.tsx
 * identityOf/findEligibleDevice): the display name alone is not enough to
 * tell two rows apart once reconciliation can leave the same name on two
 * different serials (services/reconcile.ts identityKey — serial beats MAC
 * beats name).
 */
export interface DeviceLinkIdentity {
  name: string;
  plane?: Plane | string;
  serial?: string;
}

/**
 * Canonical /devices/:name path. Every row that HAS a serial/plane (the
 * Devices screen's own rows, the site device table) must build its link with
 * this helper, never a bare `/devices/${name}` — the server resolves the
 * query pair first and only falls back to the bare name when it stays
 * unambiguous (an honest 409 otherwise, never a picked-first guess). Rows
 * from data with no identity hint (alerts, tickets, auth events, …) still
 * call this with just a name — the same legacy fallback the server honours.
 */
export function deviceDetailPath(identity: DeviceLinkIdentity): string {
  const path = `/devices/${encodeURIComponent(identity.name)}`;
  const params = new URLSearchParams();
  if (identity.plane) params.set('plane', identity.plane);
  if (identity.serial) params.set('serial', identity.serial);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Registry plane id (Systems drawer deep links) → inventory Plane label. */
const PLANE_LABEL_BY_ID: Record<string, Plane> = {
  central: 'CENTRAL',
  mist: 'MIST',
  classic: 'CLASSIC',
  greenlake: 'GREENLAKE',
  aos8: 'AOS-8',
  local: 'LOCAL',
  clearpass: 'CLEARPASS',
  uxi: 'UXI',
};

/**
 * Filter value for a `?plane=` deep-link param (the Systems plane drawer
 * links to /devices, /clients and /auth-events this way). Registry ids map
 * to their display label; anything else (already a label, or empty) passes
 * through so an absent param reads as 'all'.
 */
export function planeFilterForParam(param: string | null): string {
  if (!param) return 'all';
  return PLANE_LABEL_BY_ID[param] ?? param;
}
