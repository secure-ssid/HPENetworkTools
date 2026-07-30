/** Licences screen: subscription stats, orphans, renewals and unlicensed counts. */

import {
  EXPIRING_SOON_DAYS,
  expiryDisplay,
} from '../../planes/greenlake';
import { poller } from '../../services/poller';
import { type ReconciledDeviceRow } from '../../services/reconcile';
import { reportedValue } from './context';
import { LiveSubscription } from './liveCore';
import {
  type OrphanRow,
  type RenewalRow,
  type StatDef,
  type SubscriptionAssignment,
} from '@hpe/shared';

/**
 * The portal's ONE licence-expiry horizon, in days. Overview's "Licences
 * ≤60d" tile and the Licences screen's "Expiring ≤60d" tile answer the same
 * question and must never disagree (design/NtLicenses.dc.html:26 and the
 * OVERVIEW/LICENSE_STATS fixtures both say ≤60d). greenlake's
 * EXPIRING_SOON_DAYS (90) stays what it is — the per-subscription BADGE
 * threshold, a different judgement made by the adapter.
 */
export const LICENCE_HORIZON_DAYS = 60;

/** How far ahead the "Renewals, soonest first" panel claims to look. */
export const RENEWAL_WINDOW_DAYS = 180;

/** Renewal urgency colours, matching the fixtures' thresholds. */
export function renewalColor(daysLeft: number): string {
  if (daysLeft < 30) return 'var(--nd-danger)';
  if (daysLeft < EXPIRING_SOON_DAYS) return 'var(--nd-warning)';
  return 'var(--nd-text-muted)';
}

/**
 * The Licences screen's five Stats (README §10 — the grid is five columns
 * wide, so a four-tile row leaves a hole). The fifth, "Devices unlicensed",
 * counts reconciled devices whose plane reports no entitlement; when no plane
 * reports a licence at all it reads '—' rather than claiming a clean estate.
 */
export function liveUnlicensedStat(
  devices: ReconciledDeviceRow[],
  assignments: SubscriptionAssignment[] | null,
): StatDef {
  // The entitlement plane's own device→subscription join answers this tile
  // directly, so it wins over the per-row `licence` hint. `assigned` is
  // TRI-STATE: undefined means the plane never said, and must not be counted
  // as unlicensed — only an explicit false is a device without entitlement.
  if (assignments !== null && assignments.length > 0) {
    const stated = assignments.filter((a) => a.assigned !== undefined);
    const unlicensed = assignments.filter((a) => a.assigned === false).length;
    if (stated.length === 0) {
      return {
        label: 'Devices unlicensed',
        value: '—',
        delta: `${assignments.length} assignment${assignments.length === 1 ? '' : 's'} · none states an assignment`,
        tone: 'neutral',
      };
    }
    return {
      label: 'Devices unlicensed',
      value: String(unlicensed),
      delta: `${stated.length} of ${assignments.length} assignment${assignments.length === 1 ? '' : 's'} state an entitlement`,
      tone: unlicensed > 0 ? 'negative' : 'positive',
    };
  }
  const known = devices.filter((d) => reportedValue(d.licence));
  if (devices.length === 0 || known.length === 0) {
    return { label: 'Devices unlicensed', value: '—', delta: 'no plane reports entitlements', tone: 'neutral' };
  }
  const unlicensed = devices.length - known.length;
  return {
    label: 'Devices unlicensed',
    value: String(unlicensed),
    delta: `${known.length} of ${devices.length} devices carry an entitlement`,
    tone: unlicensed > 0 ? 'negative' : 'positive',
  };
}

/**
 * The entitlement plane's device→subscription join, when it read one. A pull
 * that could NOT read the feed declares it in `partial` and carries no
 * `assignments` key at all, so absent stays absent here — never an empty array
 * standing in for "nothing is unlicensed".
 */
export function liveAssignments(): SubscriptionAssignment[] | null {
  return poller.contributionsByPlane().get('greenlake')?.assignments ?? null;
}

/** '4 shown · +12 more' style sample line for a grouped reclaim row. */
export function assignmentSample(rows: SubscriptionAssignment[]): string {
  const names = rows.slice(0, 4).map((a) => a.deviceName ?? a.serial);
  const rest = rows.length - names.length;
  return rest > 0 ? `${names.join(' · ')} · +${rest} more` : names.join(' · ');
}

/**
 * "Orphans & gaps" — the reclaim list, derived from the entitlement join
 * rather than authored. Three tags, exactly as the design uses them:
 *   orphan — an assignment whose serial is in no plane's inventory (paying for
 *            hardware the estate no longer has);
 *   gap    — a device the plane says is unassigned, or holds no subscription;
 *   idle   — a subscription with none of its seats assigned.
 *
 * Orphan detection is gated on the merged inventory actually carrying serials:
 * against a plane that publishes none, every assignment would "match nothing"
 * and the panel would invent a estate-wide reclaim list out of a missing field.
 */
export function liveOrphans(
  devices: ReconciledDeviceRow[],
  subs: LiveSubscription[],
  assignments: SubscriptionAssignment[] | null,
): OrphanRow[] {
  const rows: OrphanRow[] = [];
  if (assignments !== null && assignments.length > 0) {
    const serials = new Set(
      devices.map((d) => d.serial?.trim().toUpperCase()).filter((s): s is string => !!s),
    );
    const orphaned =
      serials.size > 0 ? assignments.filter((a) => a.serial && !serials.has(a.serial.trim().toUpperCase())) : [];
    const orphanSerials = new Set(orphaned.map((a) => a.serial));
    const gaps = assignments.filter(
      (a) => !orphanSerials.has(a.serial) && (a.assigned === false || a.subscriptionKey === null),
    );
    if (orphaned.length > 0) {
      rows.push({
        tag: 'orphan',
        tone: 'warning',
        what: `${orphaned.length} entitlement${orphaned.length === 1 ? '' : 's'} on device${orphaned.length === 1 ? '' : 's'} no plane reports`,
        detail: `${assignmentSample(orphaned)} · not in the merged inventory · reclaim before renewal`,
      });
    }
    if (gaps.length > 0) {
      rows.push({
        tag: 'gap',
        tone: 'info',
        what: `${gaps.length} device${gaps.length === 1 ? '' : 's'} with no active subscription`,
        detail: `${assignmentSample(gaps)} · reported unassigned by the entitlement plane`,
      });
    }
  }
  const idle = subs.filter((s) => s.assignedValue === 0);
  for (const sub of idle.slice(0, 4)) {
    rows.push({
      tag: 'idle',
      tone: 'neutral',
      what: `${sub.name} — none of ${sub.qty} assigned`,
      detail: `${sub.sku} · ${sub.expires}`,
    });
  }
  if (idle.length > 4) {
    rows.push({
      tag: 'idle',
      tone: 'neutral',
      what: `+${idle.length - 4} more subscriptions with none assigned`,
      detail: 'open the subscriptions table for the full list',
    });
  }
  return rows;
}

export function liveLicenseStats(
  subs: LiveSubscription[],
  devices: ReconciledDeviceRow[],
  assignments: SubscriptionAssignment[] | null,
): StatDef[] {
  const totalQty = subs.reduce((n, s) => n + (s.qtyValue ?? 0), 0);
  const totalAssigned = subs.reduce((n, s) => n + (s.assignedValue ?? 0), 0);
  const unassigned = Math.max(0, totalQty - totalAssigned);
  const expiring = subs.filter((s) => s.daysLeft !== undefined && s.daysLeft >= 0 && s.daysLeft <= LICENCE_HORIZON_DAYS);
  const idle = subs.filter((s) => s.assignedValue === 0);
  const soonest = expiring.reduce<LiveSubscription | null>(
    (a, s) => (a === null || (s.daysLeft ?? 0) < (a.daysLeft ?? 0) ? s : a),
    null,
  );
  const pct = totalQty > 0 ? Math.round((totalAssigned / totalQty) * 100) : null;
  return [
    { label: 'Subscriptions', value: String(subs.length), delta: `${totalQty.toLocaleString('en-US')} seats`, tone: 'neutral' },
    {
      label: 'Assigned',
      value: totalAssigned.toLocaleString('en-US'),
      delta: pct === null ? 'utilisation unknown' : `${pct}% utilised`,
      tone: pct !== null && pct >= 80 ? 'positive' : 'neutral',
    },
    {
      label: 'Unassigned',
      value: unassigned.toLocaleString('en-US'),
      delta: idle.length > 0 ? `${idle.length} subscription${idle.length === 1 ? '' : 's'} with none assigned` : 'all subscriptions in use',
      tone: unassigned > 0 ? 'negative' : 'neutral',
    },
    {
      label: `Expiring ≤${LICENCE_HORIZON_DAYS}d`,
      value: String(expiring.length),
      delta: soonest?.expiresAtMs !== undefined ? `next ${expiryDisplay(soonest.expiresAtMs)}` : 'none on the horizon',
      tone: expiring.length > 0 ? 'negative' : 'positive',
    },
    liveUnlicensedStat(devices, assignments),
  ];
}

/**
 * Renewals, soonest first — only rows that carry an expiry hint can be ranked.
 * The panel's header states a window ("NEXT 180 DAYS", design/NtLicenses),
 * so the window is enforced here rather than left as a caption over an
 * unbounded dump of every dated key in the workspace. Already-overdue rows
 * (negative daysLeft) stay: they are the most urgent thing on the screen.
 */
export function liveRenewals(subs: LiveSubscription[]): RenewalRow[] {
  return subs
    .filter((s): s is LiveSubscription & { expiresAtMs: number; daysLeft: number } =>
      s.expiresAtMs !== undefined && s.daysLeft !== undefined && s.daysLeft <= RENEWAL_WINDOW_DAYS,
    )
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
    .map((s) => ({
      date: expiryDisplay(s.expiresAtMs),
      what: `${s.name} ×${s.qty}`,
      days: s.daysLeft < 0 ? 'overdue' : `${s.daysLeft}d`,
      color: renewalColor(s.daysLeft),
    }));
}
