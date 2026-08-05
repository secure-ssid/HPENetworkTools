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
  type Plane,
  type RenewalRow,
  type StatDef,
  type SubscriptionAssignment,
  countOf,
  formatCount,
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

/**
 * The subscriptions inside the horizon, split into the ones that have already
 * lapsed and the ones that are about to.
 *
 * Both tiles used to filter on `daysLeft >= 0 && daysLeft <= HORIZON`, which
 * excludes exactly the rows liveRenewals() below calls "the most urgent thing
 * on the screen". An estate whose only licence problem was a subscription that
 * lapsed yesterday counted zero, read "none on the horizon", and rendered
 * POSITIVE — green — while the renewals panel directly underneath it showed
 * the same subscription in red as `overdue`.
 *
 * One shared derivation so the Overview tile and the Licences tile cannot
 * drift apart again, in either direction.
 */
export function licencesNeedingRenewal(subs: LiveSubscription[]): {
  expired: LiveSubscription[];
  expiring: LiveSubscription[];
  undated: LiveSubscription[];
} {
  const dated = subs.filter(
    (s): s is LiveSubscription & { daysLeft: number } => s.daysLeft !== undefined,
  );
  return {
    expired: dated.filter((s) => s.daysLeft < 0),
    expiring: dated.filter((s) => s.daysLeft >= 0 && s.daysLeft <= LICENCE_HORIZON_DAYS),
    // A subscription the entitlement plane dated no expiry for is not a
    // subscription that never expires. It was silently dropped here, so a
    // workspace whose only lapsed licence carried no date counted zero and
    // rendered green. Returned rather than discarded so both tiles can say
    // how much of the answer they could not compute.
    undated: subs.filter((s) => s.daysLeft === undefined),
  };
}

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
    const archived = assignments.filter(isArchived).length;
    const live = assignments.filter((a) => !isArchived(a));
    const stated = live.filter((a) => a.assigned !== undefined);
    const unlicensed = live.filter((a) => a.assigned === false).length;
    // Excluded, and said out loud. A tile that is quietly smaller than the
    // feed it came from is a tile nobody can check.
    const archivedNote = archived > 0 ? ` · ${archived} archived, not counted` : '';
    if (stated.length === 0) {
      return {
        label: 'Devices unlicensed',
        value: '—',
        delta: `${countOf(assignments.length, 'assignment')} · none states an assignment${archivedNote}`,
        tone: 'neutral',
      };
    }
    return {
      label: 'Devices unlicensed',
      value: String(unlicensed),
      delta: `${stated.length} of ${live.length} assignment${live.length === 1 ? ' states' : 's state'} an entitlement${archivedNote}`,
      // Zero explicit `assigned: false` is only an all-clear when every
      // assignment stated one. With some silent, the honest reading is "none
      // of the ones we can see", which is not green.
      tone:
        unlicensed > 0 ? 'negative' : stated.length < live.length ? 'neutral' : 'positive',
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

/**
 * Archiving a device in GreenLake IS how it is retired, and a retired device
 * is SUPPOSED to hold no subscription. Every count below therefore takes it
 * out of the licensing-gap arithmetic: it is not a device someone forgot to
 * license, it is one somebody deliberately decommissioned, and putting it in
 * a red tile sends an operator to buy entitlement for hardware that is gone.
 *
 * Only an explicit `true` retires anything. `archived` is absent when the
 * plane never said, and dropping a device from a compliance count on a field
 * that was never read would shrink the number with no evidence behind it —
 * the opposite failure, and the worse one.
 */
function isArchived(a: SubscriptionAssignment): boolean {
  return a.archived === true;
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
 * Orphan detection is gated TWICE, because it is the only row here derived by
 * subtracting one plane's data from another's, and a subtraction is only as
 * true as the smaller operand.
 *
 * First, on the merged inventory actually carrying serials: against a plane
 * that publishes none, every assignment would "match nothing" and the panel
 * would invent an estate-wide reclaim list out of a missing field.
 *
 * Second, and the case that actually happens, on every linked plane having
 * contributed a device list at all. The merged inventory is a UNION: a plane
 * that has not finished its first pull, or whose devices read failed inside an
 * otherwise successful one, drops out of it silently and the union simply gets
 * shorter (liveCore.ts planesMissingDataset). Every entitlement on that
 * plane's estate then matches nothing and is reported as hardware the estate
 * no longer has — "reclaim before renewal" aimed at devices sitting in the
 * rack passing traffic. The serials guard does not catch it, because the other
 * nine planes are still contributing serials.
 *
 * So an incomplete inventory suppresses the orphan verdict and says so. The
 * `gap` and `archived` rows are unaffected: they read GreenLake's own
 * `assigned`/`subscriptionKey`/`archived` fields and never touch the
 * inventory, so a plane being unread costs them nothing.
 */
export function liveOrphans(
  devices: ReconciledDeviceRow[],
  subs: LiveSubscription[],
  assignments: SubscriptionAssignment[] | null,
  missingDevicePlanes: readonly Plane[] = [],
): OrphanRow[] {
  const rows: OrphanRow[] = [];
  if (assignments !== null && assignments.length > 0) {
    const serials = new Set(
      devices.map((d) => d.serial?.trim().toUpperCase()).filter((s): s is string => !!s),
    );
    /* Archived devices are held out of both buckets below and answered on
       their own terms. They are absent from the merged inventory BY DESIGN,
       so the orphan row's "no plane reports it — reclaim before renewal"
       would send someone hunting for hardware nobody lost; and they are
       unassigned BY DESIGN, so the gap row's "no active subscription" is the
       finished state, not a finding. */
    const live = assignments.filter((a) => !isArchived(a));
    const inventoryComplete = missingDevicePlanes.length === 0;
    const orphaned =
      inventoryComplete && serials.size > 0
        ? live.filter((a) => a.serial && !serials.has(a.serial.trim().toUpperCase()))
        : [];
    const orphanSerials = new Set(orphaned.map((a) => a.serial));
    const gaps = live.filter(
      (a) => !orphanSerials.has(a.serial) && (a.assigned === false || a.subscriptionKey === null),
    );
    /* The case that IS worth money and had no row at all: retired hardware
       that never gave its seat back. It escaped `gaps` precisely because it
       is still assigned, so the panel whose whole job is finding entitlement
       to reclaim was silent about the clearest instance of it. */
    const stillHolding = assignments.filter(
      (a) =>
        isArchived(a) &&
        (a.assigned === true || (typeof a.subscriptionKey === 'string' && a.subscriptionKey.trim().length > 0)),
    );
    /* Said out loud rather than left as a quiet absence. A reclaim panel with
       no orphan row reads as "nothing to reclaim", which is a finding; this
       cycle has no finding to give, and the difference is the whole point. */
    if (!inventoryComplete && live.length > 0) {
      rows.push({
        tag: 'unchecked',
        tone: 'neutral',
        what: `${countOf(live.length, 'entitlement')} not checked against the estate`,
        detail: `${missingDevicePlanes.join(' · ')} contributed no device list this cycle · an entitlement missing from a partial inventory is not evidence the hardware is gone`,
      });
    }
    if (orphaned.length > 0) {
      rows.push({
        tag: 'orphan',
        tone: 'warning',
        what: `${countOf(orphaned.length, 'entitlement')} on device${orphaned.length === 1 ? '' : 's'} no plane reports`,
        detail: `${assignmentSample(orphaned)} · not in the merged inventory · reclaim before renewal`,
      });
    }
    if (gaps.length > 0) {
      rows.push({
        tag: 'gap',
        tone: 'info',
        what: `${countOf(gaps.length, 'device')} with no active subscription`,
        detail: `${assignmentSample(gaps)} · reported unassigned by the entitlement plane`,
      });
    }
    if (stillHolding.length > 0) {
      rows.push({
        tag: 'archived',
        tone: 'warning',
        what: `${countOf(stillHolding.length, 'archived device')} still holding a subscription`,
        detail: `${assignmentSample(stillHolding)} · retired in GreenLake but the seat was never released · reclaim before renewal`,
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
  // Both halves of every seat sum are optional — greenlake omits `qtyValue`
  // and `assignedValue` rather than guessing — and both were folded to zero.
  // `licencesNeedingRenewal` learned this for dates twenty lines up: a
  // subscription the entitlement plane gave no seat count for is not a
  // subscription with no seats.
  const qtyKnown = subs.filter(
    (s): s is LiveSubscription & { qtyValue: number } => s.qtyValue !== undefined,
  );
  const assignedKnown = subs.filter(
    (s): s is LiveSubscription & { assignedValue: number } => s.assignedValue !== undefined,
  );
  // Utilisation is a ratio, so it may only be taken over rows that reported
  // BOTH halves. Dividing an assigned total that counted rows with no seat
  // count by a seat total that could not count them returned percentages far
  // over 100 — and anything at or over 80 is painted as a healthy tile.
  const measurable = subs.filter(
    (s): s is LiveSubscription & { qtyValue: number; assignedValue: number } =>
      s.qtyValue !== undefined && s.assignedValue !== undefined,
  );
  const partial = measurable.length < subs.length;
  const totalQty = qtyKnown.reduce((n, s) => n + s.qtyValue, 0);
  const totalAssigned = assignedKnown.reduce((n, s) => n + s.assignedValue, 0);
  const ratioQty = measurable.reduce((n, s) => n + s.qtyValue, 0);
  const ratioAssigned = measurable.reduce((n, s) => n + s.assignedValue, 0);
  const unassigned = Math.max(0, ratioQty - ratioAssigned);
  const { expired, expiring, undated } = licencesNeedingRenewal(subs);
  const idle = subs.filter((s) => s.assignedValue === 0);
  const soonest = expiring.reduce<LiveSubscription | null>(
    (a, s) => (a === null || (s.daysLeft ?? 0) < (a.daysLeft ?? 0) ? s : a),
    null,
  );
  const pct = ratioQty > 0 ? Math.round((ratioAssigned / ratioQty) * 100) : null;
  return [
    {
      label: 'Subscriptions',
      value: formatCount(subs.length),
      delta:
        subs.length > 0 && qtyKnown.length === 0
          ? `${countOf(subs.length, 'subscription')} · no seat count reported`
          : qtyKnown.length < subs.length
            ? `${countOf(totalQty, 'seat')} over ${qtyKnown.length} of ${subs.length}`
            : countOf(totalQty, 'seat'),
      tone: 'neutral',
    },
    {
      label: 'Assigned',
      // Not '0'. A plane that never stated an assignment has not stated none.
      value: assignedKnown.length === 0 && subs.length > 0 ? '—' : formatCount(totalAssigned),
      delta:
        assignedKnown.length === 0 && subs.length > 0
          ? `${countOf(subs.length, 'subscription')} · none states an assignment`
          : pct === null
            ? 'utilisation unknown'
            : partial
              ? `${pct}% utilised over ${measurable.length} of ${subs.length}`
              : `${pct}% utilised`,
      // Green is a claim about the whole pool. With any subscription silent on
      // either half the figure is a floor, and a floor is not an all-clear.
      tone: pct !== null && pct >= 80 && !partial ? 'positive' : 'neutral',
    },
    {
      label: 'Unassigned',
      value: measurable.length === 0 && subs.length > 0 ? '—' : formatCount(unassigned),
      delta:
        measurable.length === 0 && subs.length > 0
          ? `${countOf(subs.length, 'subscription')} · none states both a seat count and an assignment`
          : idle.length > 0
            ? `${countOf(idle.length, 'subscription')} with none assigned`
            : partial
              ? `counted across ${measurable.length} of ${subs.length} subscriptions`
              : 'all subscriptions in use',
      tone: unassigned > 0 ? 'negative' : 'neutral',
    },
    {
      // Both halves of the number are named, the way `Devices reachable` names
      // down and unverified: a lapsed subscription leads, because it is the
      // one that is costing the operator something right now.
      label: `Expiring ≤${LICENCE_HORIZON_DAYS}d`,
      value: String(expired.length + expiring.length),
      delta:
        [
          expired.length > 0 ? `${expired.length} already expired` : null,
          soonest?.expiresAtMs !== undefined ? `next ${expiryDisplay(soonest.expiresAtMs)}` : null,
          // Named in every branch, not only the quiet one: an operator
          // reading "2 already expired" still needs to know the count was
          // taken over less than the whole list.
          undated.length > 0 ? `${undated.length} undated` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ') || 'none on the horizon',
      // Green is a claim that nothing needs renewing. It can only be made
      // when every subscription was dated; otherwise this is zero KNOWN
      // problems over a partial read, which is neutral, not clean.
      tone:
        expired.length + expiring.length > 0 ? 'negative' : undated.length > 0 ? 'neutral' : 'positive',
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
