/** Overview screen: plane rows, launchpad, stats, changes and alert summaries. */

import { settings } from '../../config/settings';
import { registry } from '../../planes/registry';
import {
  PLANE_IDS,
  type PlaneHealth,
  type PlaneId,
} from '../../planes/types';
import { LOG_RETENTION_EVENT, type RetentionTombstone } from '../../services/logRotation';
import { poller } from '../../services/poller';
import {
  PLANE_LABEL,
  type ReconciledDeviceRow,
} from '../../services/reconcile';
import { writeBroker } from '../../services/writeBroker';
import { silenceStore } from '../../services/silences';
import { liveComplianceData } from './complianceModel';
import { reportedValue } from './context';
import { canOpenShell } from './deviceAccess';
import { LICENCE_HORIZON_DAYS, licencesNeedingRenewal } from './licenseModel';
import {
  LiveSubscription,
  SEV_RANK,
  ageMinutes,
  planesMissingDataset,
  planesMissingDevices,
} from './liveCore';
import {
  PLANE_MARK,
  OVERVIEW_ALERTS,
  OVERVIEW_STATS,
  isRealSiteId,
  silenceMatches,
  type AlertRow,
  type ChangeLogEntry,
  type LaneMeta,
  type LaunchpadRow,
  type OverviewAlert,
  type OverviewPlaneRow,
  type OverviewSiteRow,
  type Plane,
  type SiteRow,
  type StatDef,
  type Tone,
  localDayKey,
  countOf,
} from '@hpe/shared';

export const HEALTH_TONE: Record<PlaneHealth, Tone> = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  unlinked: 'neutral',
};

/** Worst first. The tile has room for a couple of names, and the milder
 *  problem must not stand in front of the worse one. */
const HEALTH_SEVERITY: Record<PlaneHealth, number> = {
  degraded: 0,
  warning: 1,
  healthy: 2,
  unlinked: 3,
};

/** How many unhealthy planes the delta names before it starts counting. */
const NAMED_UNHEALTHY_LIMIT = 2;

/**
 * The line under "Planes linked N / 10".
 *
 * It used to be the first unhealthy plane in roster order, which got both
 * halves of the job wrong. Roster order is not severity order, so a plane on a
 * warning could stand in front of one that was fully degraded — 'central' is
 * first in PLANE_IDS and 'sse' is last, and an operator told "Mist warning"
 * goes and looks at Mist. And naming one of several read exactly like there
 * being one: the tile is the landing screen's whole account of plane health,
 * so a second outage did not merely rank lower, it was not on the screen.
 *
 * Now: worst first, up to two named, and any remainder counted rather than
 * dropped. The wording for a single unhealthy plane is unchanged, because that
 * case was always right.
 */
export function planesLinkedDelta(
  states: Record<PlaneId, { id: PlaneId; linked: boolean; health: PlaneHealth }>,
): string {
  const linked = PLANE_IDS.filter((id) => states[id].linked);
  if (linked.length === 0) return 'none configured';
  const unhealthy = linked
    .map((id) => states[id])
    .filter((s) => s.health !== 'healthy')
    // Stable, so planes of equal severity keep roster order rather than
    // reshuffling between polls for no reason the reader can see.
    .sort((a, b) => HEALTH_SEVERITY[a.health] - HEALTH_SEVERITY[b.health]);
  if (unhealthy.length === 0) return 'all healthy';
  const named = unhealthy
    .slice(0, NAMED_UNHEALTHY_LIMIT)
    .map((s) => `${PLANE_LABEL[s.id]} ${s.health}`)
    .join(' · ');
  const rest = unhealthy.length - NAMED_UNHEALTHY_LIMIT;
  return rest > 0 ? `${named} · +${rest} more` : named;
}

/** Compact duration ('40s', '6h', '3d') — the fixtures' own vocabulary. */
export function relDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Compact relative age for the plane rows ('40s', '6h', '—' when never). */
export function relSync(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return relDuration(ms);
}

/**
 * "Management planes" — the WHOLE roster, linked first. The tile beside this
 * panel counts "Planes linked N / 10" (PLANE_IDS.length) — omitting the
 * unlinked ones made that fraction unreconcilable and hid the reason a plane
 * is dark. The kicker is a coverage fact where the registry has one (what the
 * plane actually claims), falling back to its status note — the note alone
 * just repeated the state Badge next to it while deviceCount was thrown away.
 */
export function liveOverviewPlanes(): OverviewPlaneRow[] {
  const rows: OverviewPlaneRow[] = [];
  const unlinked: OverviewPlaneRow[] = [];
  for (const id of PLANE_IDS) {
    const s = registry.state(id);
    // SSE publishes managed objects, not network devices — the registry's
    // shared count slot is the same field, so the NOUN has to be specialized
    // here exactly as the Systems card specializes its 'Objects' fact.
    // Calling 37 connector zones/users/groups "37 devices" on the Overview
    // invents an estate the plane never reported.
    const noun = id === 'sse' ? 'object' : 'device';
    const coverage =
      s.deviceCount === null
        ? null
        : `${countOf(s.deviceCount, noun)} · ${countOf(s.callsToday, 'call')} today`;
    const row: OverviewPlaneRow = {
      name: PLANE_LABEL[id],
      scope: s.linked
        ? (coverage ?? s.note ?? `${countOf(s.callsToday, 'call')} today`)
        : (s.note ?? 'no credentials configured'),
      state: s.linked ? s.health : 'not linked',
      tone: HEALTH_TONE[s.linked ? s.health : 'unlinked'],
      sync: relSync(s.lastSync),
      linked: s.linked,
    };
    (s.linked ? rows : unlinked).push(row);
  }
  return [...rows, ...unlinked];
}

/**
 * Platform-lane headers from the registry: one entry per linked plane, with
 * its real freshness stamp and health tone. Unlinked planes are omitted so a
 * lane that appears only because a device claims it falls through to the
 * client's non-asserting fallback rather than claiming to be "linked".
 * `mark` comes from the shared PLANE_MARK so live and demo lanes agree.
 */
export function liveLaneMeta(): Partial<Record<Plane, LaneMeta>> {
  const out: Partial<Record<Plane, LaneMeta>> = {};
  for (const id of PLANE_IDS) {
    const s = registry.state(id);
    if (!s.linked) continue;
    const label = PLANE_LABEL[id];
    out[label] = {
      tone: HEALTH_TONE[s.health],
      sync: s.lastSync ? `synced ${relSync(s.lastSync)}` : 'never synced',
      note: s.note ?? '',
      mark: PLANE_MARK[label],
    };
  }
  return out;
}

/**
 * Live Launchpad — portal navigation the live estate can actually honour: a
 * console hand-off per LINKED plane, an SSH row only when a live device
 * really exposes a local shell, and the two portal reports. The authored
 * rows (Mist org, Campus-01, sw-core-a) belong to the demo estate and would
 * 404 against a real one.
 */
export function liveLaunchpad(devices: ReconciledDeviceRow[]): LaunchpadRow[] {
  const rows: LaunchpadRow[] = [];
  for (const id of PLANE_IDS) {
    const s = registry.state(id);
    if (!s.linked) continue;
    const name = settings.get().planes[id]?.displayName ?? PLANE_LABEL[id];
    rows.push({ label: `Open ${name}`, hint: 'console ↗', target: { type: 'view', view: 'systems' } });
  }
  // Same gate the device page and the site reachability core use — a row that
  // merely CLAIMS a shell would put an SSH row on the Launchpad whose terminal
  // then refuses to open.
  const shell = devices.find(canOpenShell);
  if (shell) rows.push({ label: `SSH to ${shell.name}`, hint: 'terminal', target: { type: 'device', device: shell.name } });
  rows.push({ label: 'Run compliance scan', hint: 'all sites', target: { type: 'view', view: 'compliance' } });
  if (registry.state('greenlake').linked) {
    rows.push({ label: 'Reconcile licences with GreenLake', hint: 'report', target: { type: 'view', view: 'licenses' } });
  }
  return rows;
}

export function liveOverviewStats(live: { devices: ReconciledDeviceRow[]; alerts: AlertRow[] }): StatDef[] {
  const up = live.devices.filter((d) => d.state === 'up').length;
  const unverified = live.devices.filter((d) => d.state === 'unverified').length;
  // Down devices name themselves first — "8 / 9 · all verified" must never
  // hide the one that is down.
  const down = live.devices.filter((d) => d.state !== 'up' && d.state !== 'unverified').length;
  const open = live.alerts.filter((a) => a.state === 'open');
  const p1 = open.filter((a) => a.sev === 'P1').length;
  // Both numerator and denominator of these two tiles are sums over the
  // planes that answered. A linked plane that reported nothing contributes no
  // devices and no alerts, so it cannot make either number worse — it drops
  // out and leaves a smaller, calmer estate behind. The Devices and Alerts
  // screens each name that plane; the two tiles the operator actually looks
  // at first did not.
  const missingDevices = planesMissingDataset('devices');
  const missingAlerts = planesMissingDataset('alerts');
  const subs = poller.getCache().subscriptions as LiveSubscription[];
  // Same derivation as the Licences screen's tile — the two answer the same
  // question and must never disagree.
  const {
    expired: expiredLicences,
    expiring: expiringLicences,
    undated: undatedLicences,
  } = licencesNeedingRenewal(subs);
  const expiring = expiredLicences.length + expiringLicences.length;
  const states = registry.states();
  const linked = PLANE_IDS.filter((id) => states[id].linked).length;
  const unhealthy = PLANE_IDS.map((id) => states[id]).find((s) => s.linked && s.health !== 'healthy');
  const planesDelta = planesLinkedDelta(states);
  // Config drift: the same live evidence-coverage engine Configure and
  // Compliance already run, so the three screens cannot disagree. '—' only
  // when no inventory has been reported at all.
  // The scan is only as wide as the inventory behind it. A linked plane that
  // contributed no device list is not scanned at all, so a finding count of
  // zero over it means "nothing wrong with the part we read", not "nothing
  // wrong". The Compliance screen already says this; this tile and the
  // Configure one did not, which is precisely the disagreement the shared
  // derivation exists to prevent.
  const driftMissing = planesMissingDevices();
  const drift =
    live.devices.length > 0
      ? liveComplianceData(live.devices, driftMissing).findings.length
      : null;
  return [
    {
      label: 'Devices reachable',
      value: `${up} / ${live.devices.length}`,
      // Both halves of the gap between `up` and the total are named. The old
      // exclusive ternary dropped the unverified count the moment one device
      // was down — hiding the stale-plane signal exactly when the estate is
      // in trouble. Down still leads: it is the harder fact.
      delta:
        [
          down > 0 ? `▼ ${down} down` : null,
          unverified > 0 ? `${unverified} unverified` : null,
          // Last, but present in every branch: "3 down" over a fraction that
          // is missing a plane is still an incomplete answer.
          missingDevices.length > 0 ? `${missingDevices.join(', ')} not counted` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ') || 'all verified',
      tone: down > 0 || unverified > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Open alerts',
      value: String(open.length),
      // 'none critical' is the sentence that ends an operator's morning
      // check. It may only be said about a queue every linked plane answered.
      delta:
        [
          p1 > 0 ? `▲ ${p1} critical` : null,
          missingAlerts.length > 0 ? `${missingAlerts.join(', ')} did not answer` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ') || 'none critical',
      tone: open.length > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Config drift',
      value: drift === null ? '—' : String(drift),
      delta:
        drift === null
          ? 'no live inventory evidence'
          : driftMissing.length > 0
            ? `${driftMissing.join(', ')} not scanned`
            : 'live evidence coverage findings',
      tone: drift !== null && drift > 0 ? 'negative' : 'neutral',
    },
    {
      label: `Licences ≤${LICENCE_HORIZON_DAYS}d`,
      value: String(expiring),
      // A renewal coming up is a diary entry; one that has already lapsed is
      // a live problem, so only the lapsed case earns the negative tone.
      // 'none due' is a claim about every subscription in the workspace, so
      // it may only be made when every subscription carried an expiry. An
      // undated one was dropped from the count silently — it could have
      // lapsed last week.
      delta:
        expiredLicences.length > 0
          ? `▲ ${expiredLicences.length} already expired`
          : expiring > 0
            ? '▲ renewals due'
            : undatedLicences.length > 0
              ? `${undatedLicences.length} undated`
              : 'none due',
      tone: expiredLicences.length > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Planes linked',
      value: `${linked} / ${PLANE_IDS.length}`,
      delta: planesDelta,
      tone: unhealthy ? 'negative' : 'neutral',
    },
  ];
}

/**
 * The instant a row happened, for a browser to render in the reader's own
 * clock (shared/logic.ts hhmmLocal).
 *
 * This used to format hh:mm here and send the digits. The comment above it
 * said "the screen's own clock" — it was the SERVER process's clock, which is
 * the reader's only while the two are the same machine. Rendered beside times
 * the browser formats itself, in the same four-digits-and-a-colon, one screen
 * showed two timezones and nothing said so.
 *
 * A stamp that will not parse still resolves here, to '—'. It is not an
 * instant and there is nothing for the browser to improve on; passing the
 * unparseable value through would put it in a time column.
 */
export function displayTime(iso: string): string {
  return Number.isNaN(new Date(iso).getTime()) ? '—' : iso;
}

/**
 * Change log = tail of the write broker's audit log; empty until the first
 * change. The audit entry carries only the change ID and its object kind, so
 * the row is joined back to the queued change for the WHAT and WHERE the
 * spec asks for ("vlan 812 added to sw-acc-3f-2"); an applied change that has
 * left the queue falls back to the raw event line. Times are the operator's
 * local clock — the header stamp on the same screen is local, and a UTC slice
 * next to it reads as a change that happened hours from now.
 *
 * Read through readRecentEvents, which reports the rotated generations it
 * could not open. The screen's empty state calls an empty log "a fact, not a
 * failure", and that is true right up until the record cannot be read: then
 * the same blank panel asserts nothing was ever brokered here over a history
 * that exists and is unreachable. `unreadable` is carried out so the two can
 * be told apart.
 */
export function liveOverviewChanges(): { changes: ChangeLogEntry[]; unreadable: number } {
  const queued = new Map(writeBroker.list().map((change) => [change.id, change]));
  const read = writeBroker.readRecentEvents(4);
  return {
    changes: read.events.map((e) => {
      // A retention tombstone shares the file but is not a change: no
      // changeId, ticket or kind, because nothing was pushed. The generic
      // fallback interpolates all three anyway and renders
      // "log-retention undefined — discarded" by "undefined · write broker",
      // so the row written precisely to stop a deleted generation from
      // looking like an absence of changes arrives as the least legible line
      // on the screen. Say what it means instead.
      if (e.event === LOG_RETENTION_EVENT) {
        const t = e as unknown as Partial<RetentionTombstone>;
        const span = t.coveringFrom && t.coveringTo ? ` covering ${localDayKey(t.coveringFrom)} to ${localDayKey(t.coveringTo)}` : '';
        return {
          time: displayTime(e.ts),
          text: `Older audit history discarded by retention policy${span} — those entries are no longer available here`,
          who: 'retention · write broker',
        };
      }
      const change = queued.get(e.changeId);
      return {
        time: displayTime(e.ts),
        text: change ? `${change.what} — ${change.where}` : `${e.event} ${e.kind} — ${e.result}`,
        who: `${e.ticket} · write broker`,
      };
    }),
    unreadable: read.unreadable.length,
  };
}

/**
 * Live alert → the "Needs you now" view model. The row has no Site column
 * (README §1), so `meta` is where the site appears in prose — the fixtures
 * lead with it for exactly that reason, and a detail that already names the
 * site is left alone rather than doubled up.
 *
 * `siteName`/`siteId` ride along as FIELDS as well: a live mapper holds the
 * site as data and would otherwise reduce it to a prose fragment the renderer
 * has to parse to link anywhere. The prose stays until the screen renders the
 * field as its own element (handed off) — sending the field and dropping the
 * prefix in the same edit would delete the site from today's row.
 */
export function liveOverviewAlert(a: AlertRow): OverviewAlert {
  const site = reportedValue(a.siteName) ? a.siteName : null;
  const leads = site !== null && a.detail.trim().toLowerCase().startsWith(site.trim().toLowerCase());
  const meta = site === null || leads ? a.detail : [site, a.detail].filter((part) => part.trim()).join(' · ');
  return {
    sev: a.sev,
    tone: a.tone,
    title: a.title,
    meta,
    plane: a.plane,
    age: a.age,
    device: a.device,
    // Omitted, never blank: an unreported site must read as "not reported",
    // and `siteId` is only sent when it is a real site (the bookkeeping ids
    // alerts file under have no site page to link to).
    ...(site === null ? {} : { siteName: site }),
    ...(isRealSiteId(a.siteId) ? { siteId: a.siteId } : {}),
  };
}

/** Unacknowledged rows lead their severity — nobody is on them yet. */
export const ALERT_STATE_RANK: Record<AlertRow['state'], number> = { open: 0, acked: 1, cleared: 2 };

/**
 * The "Needs you now" projection: the alert queue minus the rows that no
 * longer need anyone. A row the plane itself considers resolved is not work,
 * and listing it under that heading overstates the workload (README §2) —
 * the same rule the Alerts screen applies when 'show cleared' is off, applied
 * here at the source so the panel, the stat tile and the site column agree.
 *
 * Order: severity first (as the merged queue already sorts), then unacked
 * before acked, then oldest first — a P1 nobody has touched is what the panel
 * should lead with, not a P2 that already has an owner.
 */
export function needsYouNowAlerts(alerts: AlertRow[]): OverviewAlert[] {
  return alerts
    .filter((a) => a.state !== 'cleared')
    .sort(
      (a, b) =>
        SEV_RANK[a.sev] - SEV_RANK[b.sev] ||
        ALERT_STATE_RANK[a.state] - ALERT_STATE_RANK[b.state] ||
        ageMinutes(b.age) - ageMinutes(a.age),
    )
    .map(liveOverviewAlert);
}

/**
 * The demo Overview through the SAME silences the Alerts screen benches.
 *
 * Silences are real operator data and apply in both modes (silences.ts), so a
 * hushed firing must not headline the landing screen while its row is benched
 * on Alerts. The authored rows are already one-per-problem, so matching each
 * against the active silences IS the partitionAlertGroups split for this
 * list. The 'Open alerts' tile keeps the authored estate narrative minus
 * exactly what was hushed — each panel row is one of the open alerts the
 * tile counts, and the two panel P1s are its '2 critical' — and names the
 * hushed count, so the estate never reads quieter than it is. Nothing
 * hushed → the fixtures come back untouched, byte for byte.
 */
export function demoOverviewQueue(now: number = Date.now()): { stats: StatDef[]; alerts: OverviewAlert[] } {
  const silences = silenceStore.active(now);
  const hushed =
    silences.length === 0 ? [] : OVERVIEW_ALERTS.filter((row) => silences.some((s) => silenceMatches(s, row)));
  if (hushed.length === 0) return { stats: OVERVIEW_STATS, alerts: OVERVIEW_ALERTS };
  const hushedP1 = hushed.filter((row) => row.sev === 'P1').length;
  const authoredP1 = OVERVIEW_ALERTS.filter((row) => row.sev === 'P1').length;
  const stats = OVERVIEW_STATS.map((tile) => {
    if (tile.label !== 'Open alerts') return tile;
    const authoredOpen = Number(tile.value);
    // A tile whose authored count will not parse is left exactly as authored —
    // adjusting a number we cannot read would be its own kind of invention.
    if (!Number.isFinite(authoredOpen)) return tile;
    const open = Math.max(0, authoredOpen - hushed.length);
    const p1 = Math.max(0, authoredP1 - hushedP1);
    return {
      ...tile,
      value: String(open),
      delta: [p1 > 0 ? `▲ ${p1} critical` : 'none critical', `${hushed.length} silenced`].join(' · '),
      tone: open > 0 ? ('negative' as const) : ('neutral' as const),
    };
  });
  return { stats, alerts: OVERVIEW_ALERTS.filter((row) => !hushed.includes(row)) };
}

/** Live site row → the Overview Sites-table view model (badges → a prose plane label). */
export function liveOverviewSite(s: SiteRow): OverviewSiteRow {
  return {
    name: s.name,
    siteId: s.id,
    plane: s.planes.map((b) => b.name).join(' · ') || '—',
    devices: s.devices,
    clients: s.clients,
    health: s.health,
    healthPct: s.healthPct,
    tone: s.tone,
    alerts: s.alerts,
    alertTone: s.alertTone,
  };
}
