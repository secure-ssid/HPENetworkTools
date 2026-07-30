/** Overview screen: plane rows, launchpad, stats, changes and alert summaries. */

import { settings } from '../../config/settings';
import { registry } from '../../planes/registry';
import {
  PLANE_IDS,
  type PlaneHealth,
} from '../../planes/types';
import { poller } from '../../services/poller';
import {
  PLANE_LABEL,
  type ReconciledDeviceRow,
} from '../../services/reconcile';
import { writeBroker } from '../../services/writeBroker';
import { liveComplianceData } from './complianceModel';
import { reportedValue } from './context';
import { canOpenShell } from './deviceAccess';
import { LICENCE_HORIZON_DAYS } from './licenseModel';
import {
  LiveSubscription,
  SEV_RANK,
  ageMinutes,
} from './liveCore';
import {
  PLANE_MARK,
  isRealSiteId,
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
} from '@hpe/shared';

export const HEALTH_TONE: Record<PlaneHealth, Tone> = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  unlinked: 'neutral',
};

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
        : `${s.deviceCount.toLocaleString('en-US')} ${noun}${s.deviceCount === 1 ? '' : 's'} · ${s.callsToday} call${s.callsToday === 1 ? '' : 's'} today`;
    const row: OverviewPlaneRow = {
      name: PLANE_LABEL[id],
      scope: s.linked ? (coverage ?? s.note ?? `${s.callsToday} calls today`) : (s.note ?? 'no credentials configured'),
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
  const subs = poller.getCache().subscriptions as LiveSubscription[];
  const expiring = subs.filter(
    (s) => s.daysLeft !== undefined && s.daysLeft >= 0 && s.daysLeft <= LICENCE_HORIZON_DAYS,
  ).length;
  const states = registry.states();
  const linked = PLANE_IDS.filter((id) => states[id].linked).length;
  const unhealthy = PLANE_IDS.map((id) => states[id]).find((s) => s.linked && s.health !== 'healthy');
  // Config drift: the same live evidence-coverage engine Configure and
  // Compliance already run, so the three screens cannot disagree. '—' only
  // when no inventory has been reported at all.
  const drift = live.devices.length > 0 ? liveComplianceData(live.devices).findings.length : null;
  return [
    {
      label: 'Devices reachable',
      value: `${up} / ${live.devices.length}`,
      // Both halves of the gap between `up` and the total are named. The old
      // exclusive ternary dropped the unverified count the moment one device
      // was down — hiding the stale-plane signal exactly when the estate is
      // in trouble. Down still leads: it is the harder fact.
      delta:
        [down > 0 ? `▼ ${down} down` : null, unverified > 0 ? `${unverified} unverified` : null]
          .filter((part): part is string => part !== null)
          .join(' · ') || 'all verified',
      tone: down > 0 || unverified > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Open alerts',
      value: String(open.length),
      delta: p1 > 0 ? `▲ ${p1} critical` : 'none critical',
      tone: open.length > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Config drift',
      value: drift === null ? '—' : String(drift),
      delta: drift === null ? 'no live inventory evidence' : 'live evidence coverage findings',
      tone: drift !== null && drift > 0 ? 'negative' : 'neutral',
    },
    {
      label: `Licences ≤${LICENCE_HORIZON_DAYS}d`,
      value: String(expiring),
      delta: expiring > 0 ? '▲ renewals due' : 'none due',
      tone: 'neutral',
    },
    {
      label: 'Planes linked',
      value: `${linked} / ${PLANE_IDS.length}`,
      delta: linked === 0 ? 'none configured' : unhealthy ? `${PLANE_LABEL[unhealthy.id]} ${unhealthy.health}` : 'all healthy',
      tone: unhealthy ? 'negative' : 'neutral',
    },
  ];
}

/** Local hh:mm for an ISO instant — the screen's own clock, not UTC. */
export function localHhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Change log = tail of the write broker's audit log; empty until the first
 * change. The audit entry carries only the change ID and its object kind, so
 * the row is joined back to the queued change for the WHAT and WHERE the
 * spec asks for ("vlan 812 added to sw-acc-3f-2"); an applied change that has
 * left the queue falls back to the raw event line. Times are the operator's
 * local clock — the header stamp on the same screen is local, and a UTC slice
 * next to it reads as a change that happened hours from now.
 */
export function liveOverviewChanges(): ChangeLogEntry[] {
  const queued = new Map(writeBroker.list().map((change) => [change.id, change]));
  return writeBroker.recentEvents(4).map((e) => {
    const change = queued.get(e.changeId);
    return {
      time: localHhmm(e.ts),
      text: change ? `${change.what} — ${change.where}` : `${e.event} ${e.kind} — ${e.result}`,
      who: `${e.ticket} · write broker`,
    };
  });
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
