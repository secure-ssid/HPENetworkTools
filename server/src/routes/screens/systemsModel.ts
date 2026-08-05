/** Systems screen: per-plane rows, scope, token facts and console links. */

import { relDuration } from './overviewModel';
import { settings } from '../../config/settings';
import { registry } from '../../planes/registry';
import {
  PLANE_IDS,
  type PlaneHealth,
  type PlaneId,
  type PlanePull,
  type PlaneState,
} from '../../planes/types';
import { poller } from '../../services/poller';
import {
  displayTime,
  relSync,
} from './overviewModel';
import {
  CONNECT_ENDPOINT_KEY,
  scopeForPlane,
  type LiveStat,
  type PlaneKey,
  type SiteId,
  type SyncHistoryRow,
  type SystemEvent,
  type SystemRow,
  type SystemSiteRow,
  type Tone,
  formatCount,
  countOf,
} from '@hpe/shared';

/**
 * Display names the Systems screen merges its live state on — the same
 * strings the fixture SYSTEMS rows use. AOS-10 is represented explicitly as
 * a registry plane even though its data path is brokered through Central.
 */
export const SYSTEM_DISPLAY: Partial<Record<PlaneId, string>> = {
  central: 'HPE Aruba Central',
  classic: 'Central Classic',
  mist: 'Mist',
  greenlake: 'GreenLake',
  aos8: 'AOS-8 mobility master',
  aos10: 'AOS-10 (via Central)',
  local: 'Local switch collector',
  clearpass: 'ClearPass',
  uxi: 'UXI',
  sse: 'HPE Aruba Networking SSE',
  edgeconnect: 'EdgeConnect SD-WAN',
  opsramp: 'HPE OpsRamp',
};

export const SYSTEM_HEALTH_TONE: Record<PlaneHealth, Tone> = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  unlinked: 'neutral',
};

export const SCOPE_TONE: Record<ReturnType<typeof scopeForPlane>, Tone> = {
  'read only': 'neutral',
  'read + broker': 'accent',
  'read + ssh': 'accent',
  'read + direct': 'accent',
};

/** "Sites on this plane" — what THIS plane actually reported, never the merge. */
export function planeSites(pull: PlanePull | undefined): SystemSiteRow[] {
  if (!pull) return [];
  const byId = new Map<SiteId, { name: string; devices: number; clients: number }>();
  const note = (siteId: SiteId, name: string): { name: string; devices: number; clients: number } => {
    const seen = byId.get(siteId);
    if (seen) return seen;
    const fresh = { name, devices: 0, clients: 0 };
    byId.set(siteId, fresh);
    return fresh;
  };
  for (const row of pull.sites ?? []) note(row.id, row.name);
  for (const row of pull.devices ?? []) note(row.siteId, row.siteName).devices += 1;
  for (const row of pull.clients ?? []) note(row.siteId, row.siteName).clients += 1;
  return [...byId.entries()].map(([siteId, s]) => ({
    siteId,
    name: s.name,
    // A tally over a dataset the pull never carried is not a tally. The sites
    // list can arrive without the inventory beside it, and every row then read
    // '0 devices' for an estate nobody had counted — a number an operator
    // cannot check by looking at it, and one that travels alone into the
    // Systems CSV. planeLiveStats, immediately below, has always asked whether
    // a dataset was reported before publishing a figure from it.
    detail: [
      pull.devices === undefined ? 'devices not reported' : countOf(s.devices, 'device'),
      pull.clients === undefined ? 'clients not reported' : countOf(s.clients, 'client'),
    ].join(' · '),
  }));
}

/** "Live on this plane" — one counter per dataset this plane contributes. */
export function planeLiveStats(pull: PlanePull | undefined): LiveStat[] {
  if (!pull) return [];
  const rows: LiveStat[] = [];
  if (pull.devices) rows.push({ value: String(pull.devices.length), label: 'devices claimed' });
  if (pull.clients) rows.push({ value: String(pull.clients.length), label: 'client sessions' });
  if (pull.alerts) rows.push({ value: String(pull.alerts.filter((a) => a.state === 'open').length), label: 'open alerts' });
  if (pull.subscriptions) rows.push({ value: String(pull.subscriptions.length), label: 'subscriptions' });
  if (pull.authEvents) rows.push({ value: String(pull.authEvents.length), label: 'auth events' });
  if (pull.sse) {
    const kinds = Object.values(pull.sse.kinds);
    const totalObjects = kinds.reduce((sum, k) => sum + (k?.rows.length ?? 0), 0);
    rows.push({
      value: formatCount(totalObjects),
      label: `SSE objects across ${countOf(kinds.length, 'kind')}`,
    });
    if (pull.sse.unavailable.length > 0) {
      rows.push({ value: String(pull.sse.unavailable.length), label: 'SSE kinds unavailable (scope or limited release)' });
    }
  }
  return rows;
}

/**
 * "Recent events" — the plane's own event log (credential changes, poll
 * failures, backoff, recovery: registry.recentEvents) merged with its entries
 * in the poller's sync log, newest first. The registry log is the one that
 * carries the events an operator opens this drawer for; the sync log alone
 * only ever showed polls. Times are the operator's local clock, like every
 * other stamp on the screen.
 */
export function planeEvents(id: PlaneId): SystemEvent[] {
  const fromRegistry = registry.recentEvents(id).map((e) => ({ time: e.time, what: e.what, who: e.who }));
  const fromPoller = poller
    .history()
    .filter((e) => e.plane === id)
    .map((e) => ({ time: e.time, what: e.what, who: `poller · ${e.result}` }));
  return [...fromRegistry, ...fromPoller]
    .sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? 1 : -1))
    .slice(0, 6)
    .map((e) => ({ time: displayTime(e.time), what: e.what, who: e.who }));
}

/**
 * The drawer's fourth fact: credential freshness — how the plane is
 * authenticated and when that credential runs out. Never the secret, and
 * never a claim: a plane that publishes no expiry says so.
 */
export function tokenFact(s: PlaneState): string {
  if (!s.linked) return 'no credentials stored';
  const token = s.token;
  if (!token) return 'not reported';
  if (token.expiresAt === null) return `${token.source} · no expiry published`;
  const ms = new Date(token.expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return token.source;
  return ms <= 0 ? `${token.source} · expired` : `${token.source} · expires in ${relDuration(ms)}`;
}

/**
 * Planes whose STORED endpoint credential is the administration surface
 * itself — the host an operator logs into: an AOS-8 mobility master (its own
 * HTTPS UI), a ClearPass publisher, a classic-Central region URL.
 *
 * The other five deliberately publish no console, so "Open console" stays
 * inert for them and says so (SystemRow.consoleUrl's contract) rather than
 * opening a page that is not a console:
 *   central   — stores an API GATEWAY (apigw-…); the console is a different
 *               hostname (app-…) the portal does not hold and must not guess.
 *   mist      — same: api.mist.com is stored, manage.mist.com is the console.
 *   greenlake — stores a workspace UUID, which is not a host at all.
 *   local     — an SSH jump box; the collector has no web console (SYSTEMS
 *               records none for it either).
 *   sse       — stores the Admin API host (admin-api.axissecurity.com); the
 *               operator console is a different hostname the portal does not
 *               hold and must not guess, same reasoning as central/mist.
 */
export const CONSOLE_ENDPOINT_PLANES = ['classic', 'aos8', 'clearpass'] as const;

export type ConsoleEndpointPlane = (typeof CONSOLE_ENDPOINT_PLANES)[number];

export function isConsoleEndpointPlane(id: PlaneId): id is ConsoleEndpointPlane {
  return (CONSOLE_ENDPOINT_PLANES as readonly PlaneId[]).includes(id);
}

/**
 * The console URL for a live plane, read off the credential the operator
 * actually stored (the same key the connect drawer writes, CONNECT_ENDPOINT_KEY
 * — ClearPass's drawer writes `publisher`, so its aliases are accepted too).
 *
 * Only the ORIGIN is served: a stored API path is not a console, and an origin
 * also drops any userinfo a pasted URL carried, so nothing credential-shaped
 * can ride out on this field. Anything that does not parse as a host at all
 * (GreenLake's workspace UUID, a typo) yields undefined — an absent key, which
 * the screen must render as "no console URL recorded".
 */
export function planeConsoleUrl(id: PlaneId): string | undefined {
  if (!isConsoleEndpointPlane(id)) return undefined;
  const creds = settings.get().planes[id];
  if (!creds) return undefined;
  const raw = [CONNECT_ENDPOINT_KEY[id], 'publisher', 'baseUrl', 'host']
    .map((key) => creds[key])
    .find((value) => typeof value === 'string' && value.trim() !== '')
    ?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname === '' ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * One registry plane as a SystemRow. Everything comes from what the portal
 * actually holds: the registry's link/health/freshness, the plane's own last
 * good pull (its sites, its dataset counts), its entries in the sync log, and
 * the MASKED credential record from settings. The call log is still overlaid
 * client-side from /api/systems/state.
 */
export function liveSystemRow(id: PlaneId, s: PlaneState, pull: PlanePull | undefined): SystemRow {
  // The operator's stored displayName (set in the connect drawer) wins over
  // the registry default — a rename must survive onto the screen.
  const stored = settings.get().planes[id];
  const masked = settings.maskedView().planes[id];
  // The granted scope, crossed with what this plane's adapter says it can
  // carry out. The Configure capability matrix reads the SAME helper, with
  // one deliberate difference: only this call passes `directWrite`, because
  // "the portal can write objects here" (Systems) and "a port/SSID/VLAN
  // change can be pushed here" (Configure) are different questions, and SSE
  // answers yes to the first and no to the second.
  const scope = effectiveScope(
    s,
    scopeForPlane(id as PlaneKey, {
      linked: s.linked,
      scopes: stored?.scopes ?? null,
      directWrite: s.capabilities?.directWrite,
    }),
  );
  const consoleUrl = planeConsoleUrl(id);
  return {
    name: stored?.displayName ?? SYSTEM_DISPLAY[id]!,
    planeId: id,
    // Only when the portal really holds one — an absent key is what makes
    // "Open console" inert instead of a hand-off it cannot make.
    ...(consoleUrl === undefined ? {} : { consoleUrl }),
    kind: s.linked ? 'live plane registry' : 'not linked',
    state: s.health === 'unlinked' ? 'warning' : s.health,
    tone: SYSTEM_HEALTH_TONE[s.health],
    // Derived from what the write broker can really do for this plane and
    // what the operator granted — the same helper the capability matrix
    // reads, so the two screens cannot contradict each other.
    scope,
    scopeTone: SCOPE_TONE[scope],
    scopeNote: !s.linked
      ? 'no credentials stored'
      : scope === 'read only'
        ? 'no write path from the portal to this plane'
        : scope === 'read + ssh'
          ? 'recorded shell, change window only'
          : scope === 'read + direct'
            ? 'reviewed object writes, tenant-wide commit'
            : 'brokered writes, ticket required',
    facts: [
      { k: 'Last sync', v: s.lastSync ? relSync(s.lastSync) : 'never' },
      { k: id === 'sse' ? 'Objects' : 'Devices', v: s.deviceCount === null ? '—' : formatCount(s.deviceCount) },
      // The budget is the denominator that makes "Calls today" mean anything
      // (Mist allows 20k/day); a plane whose tier the portal does not know
      // renders the bare count rather than inventing a limit.
      {
        k: 'Calls today',
        v:
          s.callBudget === undefined || s.callBudget === null
            ? formatCount(s.callsToday)
            : `${formatCount(s.callsToday)} / ${formatCount(s.callBudget)}`,
      },
      { k: 'Token', v: tokenFact(s) },
    ],
    sites: planeSites(pull),
    live: planeLiveStats(pull),
    calls: [],
    events: planeEvents(id),
    pulls: [{ what: 'poll()', every: `every ${settings.get().pollIntervalSec}s`, mode: 'read', tone: 'neutral' }],
    configText: [
      `plane: ${id}`,
      `linked: ${s.linked}`,
      `health: ${s.health}`,
      `last_sync: ${s.lastSync ?? 'never'}`,
      s.deviceCount === null ? null : `${id === 'sse' ? 'objects' : 'devices'}: ${s.deviceCount}`,
      `calls_today: ${s.callsToday}`,
      // The denominator behind the "Calls today" fact, when the portal knows
      // the plane's tier — an absent budget prints no line rather than a
      // guessed quota (README:316).
      s.callBudget === undefined || s.callBudget === null ? null : `rate_limit: ${s.callBudget}/day`,
      s.note ? `note: ${s.note}` : null,
      // The stored credential record, exactly as maskedView() renders it —
      // endpoint, client id, workspace and scopes are the record the
      // Configuration tab exists to show; secrets stay masked.
      ...Object.entries(masked ?? {})
        .filter(([key]) => key !== 'displayName')
        .map(([key, value]) => `${key}: ${value}`),
      `scope: ${scope}`,
      `poll_interval: ${settings.get().pollIntervalSec}s`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
  };
}

/** Poller sync log → the SyncHistoryRow shape the screen contract declares. */
export function liveSyncHistory(): SyncHistoryRow[] {
  return poller.history().map((e) => ({
    time: e.time,
    system: e.plane,
    what: e.what,
    result: e.result,
    tone: e.result === 'ok' ? 'success' : 'danger',
  }));
}

/** The registry as SystemRows — the live half of the /api/systems payload. */
export function liveSystemRows(states: Record<PlaneId, PlaneState>): SystemRow[] {
  const pulls = poller.contributionsByPlane();
  return PLANE_IDS.filter((id) => SYSTEM_DISPLAY[id]).map((id) => liveSystemRow(id, states[id], pulls.get(id)));
}


export function effectiveScope(
  state: PlaneState,
  granted: ReturnType<typeof scopeForPlane>,
): ReturnType<typeof scopeForPlane> {
  const caps = state.capabilities;
  if (!caps) return granted;
  // SSE has no ticketed broker at all — PLANE_WRITE_MODE.sse is 'read only'
  // (accurate for the Configure screen's port/SSID/VLAN capability matrix,
  // which SSE never participates in), so scopeForPlane('sse', …) can never
  // itself answer 'read + broker'. Its real write capability is reported
  // through capabilities().directWrite instead (the Systems Configuration
  // tab's object CRUD); scopeForPlane turns that into 'read + direct' when
  // the caller passes it, and since it only does so while directWrite is
  // already true there is nothing for this helper to downgrade.
  if (granted === 'read + broker' && caps.brokeredWrite === false) return 'read only';
  if (granted === 'read + ssh' && caps.localShell === false) return 'read only';
  if (granted === 'read + direct' && caps.directWrite === false) return 'read only';
  return granted;
}
