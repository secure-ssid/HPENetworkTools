/**
 * Systems screen: the facts a plane row shows, and how they are derived.
 *
 * Kept apart from the components because these decide what is TRUE about a
 * plane — whether a credential changed, whether a count was reported at all,
 * how stale a sync is — and those answers have to be identical wherever they
 * are rendered. mergedFacts in particular is the reason a plane that reported
 * nothing says so rather than showing a zero.
 */

import {
  type LivePlaneState,
  type SystemCredentialPayload,
} from '../../api/client';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  CONNECT_ENDPOINT_KEY,
  hhmmLocal as hhmm,
  type Fact,
  type ScreenSection,
  type SystemRow,
  type SystemTypeKey,
  type Tone,
} from '@hpe/shared';

/** Fixture system name → registry plane id (the seven connectable planes). */
export const PLANE_ID_BY_NAME: Record<string, SystemTypeKey> = {
  'HPE Aruba Central': 'central',
  Mist: 'mist',
  'Central Classic': 'classic',
  GreenLake: 'greenlake',
  'AOS-8 mobility master': 'aos8',
  'Local switch collector': 'local',
  ClearPass: 'clearpass',
  UXI: 'uxi',
};

export const HEALTH_TONE: Record<LivePlaneState['health'], Tone> = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  unlinked: 'neutral',
};

/**
 * Current Central API-gateway clusters — devhub.arubanetworks.com/new-central
 * ("Getting Started with REST APIs" base-URL table, incl. the internal
 * cluster). The account's own base URL shows under Central → API Gateway →
 * REST API; a gateway not in the list can be typed directly.
 */
export const CENTRAL_REGIONS: Array<{ value: string; label: string }> = [
  { value: 'https://us1.api.central.arubanetworks.com', label: 'US-1' },
  { value: 'https://us2.api.central.arubanetworks.com', label: 'US-2' },
  { value: 'https://us6.api.central.arubanetworks.com', label: 'US-East1' },
  { value: 'https://us4.api.central.arubanetworks.com', label: 'US-West4' },
  { value: 'https://us5.api.central.arubanetworks.com', label: 'US-West5' },
  { value: 'https://de1.api.central.arubanetworks.com', label: 'EU-1' },
  { value: 'https://de2.api.central.arubanetworks.com', label: 'EU-Central2' },
  { value: 'https://de3.api.central.arubanetworks.com', label: 'EU-Central3' },
  { value: 'https://gb1.api.central.arubanetworks.com', label: 'UK' },
  { value: 'https://ca1.api.central.arubanetworks.com', label: 'Canada-1' },
  { value: 'https://in1.api.central.arubanetworks.com', label: 'APAC-1' },
  { value: 'https://jp1.api.central.arubanetworks.com', label: 'APAC-East1' },
  { value: 'https://au1.api.central.arubanetworks.com', label: 'APAC-South1' },
  { value: 'https://ae1.api.central.arubanetworks.com', label: 'UAE' },
  { value: 'https://cn1.api.central.arubanetworks.com.cn', label: 'China-1' },
  { value: 'https://internal.api.central.arubanetworks.com', label: 'Internal' },
];

export type DetailTab = 'summary' | 'activity' | 'config';

export const TAB_OPTIONS: Array<{ value: DetailTab; label: string }> = [
  { value: 'summary', label: 'Summary' },
  { value: 'activity', label: 'Activity' },
  { value: 'config', label: 'Configuration' },
];

export interface ScopeFlags {
  inventory: boolean;
  clientsAuth: boolean;
  configLicences: boolean;
  write: boolean;
}

export const DEFAULT_SCOPES: ScopeFlags = {
  inventory: true,
  clientsAuth: true,
  configLicences: true,
  write: false,
};

export interface CredentialSnapshot {
  plane: SystemTypeKey;
  credentials: SystemCredentialPayload;
}

export function sameCredentialValue(
  left: SystemCredentialPayload[string],
  right: SystemCredentialPayload[string],
): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameCredentialSnapshot(
  left: CredentialSnapshot | null,
  right: CredentialSnapshot | null,
): boolean {
  if (!left || !right || left.plane !== right.plane) return false;
  const leftKeys = Object.keys(left.credentials).sort();
  const rightKeys = Object.keys(right.credentials).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameCredentialValue(left.credentials[key]!, right.credentials[key]!),
    )
  );
}

export function storedEndpoint(row: SystemRow, plane: SystemTypeKey): string {
  const prefix = `${CONNECT_ENDPOINT_KEY[plane]}:`;
  const line = row.configText.split('\n').find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim() ?? '';
  return value.includes('••') ? '' : value;
}

/** credPayload()'s own scope tokens, keyed by the ScopeFlags field they came
 *  from — the one vocabulary storedScopes() reads back and selectedScopes()
 *  writes, so a re-key can never drift from what a save actually recorded. */
export const SCOPE_TOKEN: Record<keyof ScopeFlags, string> = {
  inventory: 'read:inventory',
  clientsAuth: 'read:clients-auth',
  configLicences: 'read:config-licences',
  write: 'write:brokered',
};

export const BROKERED_WRITE_SCOPE_LABEL =
  'Brokered write — config push, requires a ticket reference';

export const SSE_WRITE_SCOPE_LABEL =
  'Direct write — reviewed SSE object mutations followed by tenant-wide Commit';

/**
 * The scopes a linked plane actually has, read back for re-key so rotating a
 * token prefills — and, absent an explicit operator toggle, PRESERVES —
 * what was already granted rather than resetting to the connect-drawer's
 * safe-for-a-new-connection defaults (write off). The granular `scopes:`
 * line in configText (unmasked — it is not secret-shaped) carries the read
 * flags; the write bit additionally trusts the registry's own
 * `capabilities.directWrite` when the plane reports one, because SSE's write
 * grant lives ENTIRELY there (PLANE_WRITE_MODE says 'read only' for SSE
 * either way, so the coarse `scope:` line can never carry it) — that is the
 * one signal a rotated token must never silently contradict.
 */
export function storedScopes(row: SystemRow, live: LivePlaneState | null): ScopeFlags {
  const line = row.configText.split('\n').find((candidate) => candidate.startsWith('scopes:'));
  const tokens = (line?.slice('scopes:'.length).trim() ?? '').split(',').map((t) => t.trim());
  // An absent line is a legacy/unconfigured record and gets safe defaults.
  // A present-but-empty line is different: it is the persisted representation
  // of scopes: [] and must reopen with every checkbox still revoked.
  const base: ScopeFlags = line !== undefined
    ? {
        inventory: tokens.includes(SCOPE_TOKEN.inventory),
        clientsAuth: tokens.includes(SCOPE_TOKEN.clientsAuth),
        configLicences: tokens.includes(SCOPE_TOKEN.configLicences),
        write: tokens.includes(SCOPE_TOKEN.write),
      }
    : DEFAULT_SCOPES;
  return live?.capabilities?.directWrite === undefined
    ? base
    : { ...base, write: live.capabilities.directWrite === true };
}

// -- formatting helpers -------------------------------------------------------

/** A span of seconds in this screen's own vocabulary. */
function agoText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Age an ISO stamp against this browser's clock. Only for a stamp the server
 * did not age for us — see syncAgeText.
 *
 * `now` is a parameter so this is testable at all; it used to read Date.now()
 * from inside, which made every caller's output depend on the wall clock.
 */
export function relTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const ms = now - t;
  // Not clamped to zero. A stamp further ahead than two clocks can plausibly
  // drift is not an age, and reporting it as '0s ago' would be an invented
  // freshness — the same fabrication shared/logic.ts planeFreshness was
  // carrying until it learned this bound.
  if (ms < -CLOCK_SKEW_TOLERANCE_MS) return '—';
  return agoText(ms / 1000);
}

/**
 * How old the last good sync is — taken from the number the SERVER aged it
 * to, not re-derived here.
 *
 * `ageSec` arrives beside `stale` and is the value that decision was made
 * from (shared/logic.ts planeFreshness, against the same clock that wrote
 * `lastSync`). Re-aging the ISO string in the browser measured one clock's
 * stamp with another's, so the row could print '3s ago' beside a stale badge,
 * or '45m ago' beside a fresh one — two answers to one question, on one line.
 *
 * The three states are kept apart. A plane that has never synced says so. A
 * plane whose stamp cannot be aged — unparseable, or further ahead than drift
 * explains — must NOT say 'never': it has synced, and only the age is
 * unknown. It reports the stamp itself, which is the fact that survives.
 * `ageSec` absent entirely means an older server that never sent one, and
 * that is the only case left with nothing better than the browser's clock.
 */
export function syncAgeText(live: LivePlaneState, now: number = Date.now()): string {
  if (live.ageSec === undefined) return relTime(live.lastSync, now);
  if (live.ageSec !== null) return agoText(live.ageSec);
  if (live.lastSync === null) return 'never';
  return `synced ${hhmm(live.lastSync)} — age unreadable`;
}

export function msFmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Status-Badge tone for a live call code: 2xx/ok success, 429 warning, 5xx/fail danger. */
export function codeTone(code: string): Tone {
  if (code === 'ok' || /^2\d\d$/.test(code)) return 'success';
  if (code === '429') return 'warning';
  if (code === 'fail' || /^5\d\d$/.test(code)) return 'danger';
  return 'neutral';
}

// -- fixture ⇄ live merge ------------------------------------------------------

/** Fact keys that carry a plane's indexed-object count — GreenLake counts
 *  subscriptions and ClearPass endpoints, so keying the live override off
 *  'Devices' alone would never reach them. */
export const COUNT_FACT_KEYS = ['Devices', 'Objects', 'Subscriptions', 'Endpoints'];

/**
 * "Calls today" against the plane's own daily budget — the denominator the
 * registry serves (LivePlaneState.callBudget) and the only thing that makes
 * the count mean anything (Mist allows 20k/day). A plane whose tier the
 * portal does not know renders the bare count rather than inventing a limit,
 * exactly as the server formats the same fact (screens.ts liveSystemRow).
 */
export function callsFactValue(live: LivePlaneState): string {
  const budget = live.callBudget;
  if (budget === undefined || budget === null) return String(live.callsToday);
  return `${live.callsToday.toLocaleString('en-US')} / ${budget.toLocaleString('en-US')}`;
}

/**
 * README honesty rule: a plane whose last good sync has aged past the
 * registry's staleness window is behind, so what it reports is `unverified`
 * rather than current — the same word Alerts and Clients use for a row
 * sourced from such a plane. The flag is the registry's own age-based
 * `stale` (shared/logic.ts planeStaleness), never re-derived here.
 */
export function staleTitle(live: LivePlaneState): string {
  // A never-synced plane is deliberately not reported as `stale` by the
  // registry (planes/registry.ts — it reports that through `reason`), so this
  // sentence is only ever said about a plane that HAS synced. Reading a null
  // `ageSec` as 'never' put the one word that contradicts the rest of the
  // sentence into it, for the stamp that could not be aged.
  return `last good sync ${syncAgeText(live)} — past the registry's staleness window, so this plane's rows are unverified, not current`;
}

/** Retry state for a plane the poller keeps failing on — served facts, not a
 *  guess: how many consecutive polls failed and when the next one is due. */
export function retryNote(live: LivePlaneState): string | null {  const fails = live.consecutiveFailures ?? 0;
  if (fails <= 0) return null;
  const next = live.nextAttemptAt ? ` · next attempt ${hhmm(live.nextAttemptAt)}` : '';
  return `${fails} consecutive failed poll${fails === 1 ? '' : 's'}${next}`;
}

/** Fact strip: live values override the matching facts when present. Only
 *  called for a live-sourced row — a demo row keeps its authored facts. */
export function mergedFacts(s: SystemRow, live: LivePlaneState | null): Fact[] {
  if (!live) return s.facts;
  let counted = false;
  const facts = s.facts.map((f) => {
    if (f.k === 'Last sync') return { ...f, v: syncAgeText(live) };
    if (f.k === 'Calls today') return { ...f, v: callsFactValue(live) };
    if (COUNT_FACT_KEYS.includes(f.k) && live.deviceCount != null) {
      counted = true;
      return { ...f, v: String(live.deviceCount) };
    }
    return f;
  });
  // A plane whose row has no count fact at all still gets one appended.
  if (!counted && live.deviceCount != null) {
    facts.push({
      k: s.planeId === 'sse' ? 'Objects' : 'Devices',
      v: String(live.deviceCount),
    });
  }
  return facts;
}

/** One merged plane as the list renders it. */
export type PlaneView = {
  row: SystemRow;
  planeId: SystemTypeKey | null;
  live: LivePlaneState | null;
  stateLabel: string;
  stateTone: Tone;
  facts: Fact[];
};

export function factValue(facts: Fact[], key: string): string | null {
  return facts.find((f) => f.k === key)?.v ?? null;
}

/** The count fact, with its own noun so "37" is never read as devices when the
 *  plane counts objects, subscriptions or endpoints. */
export function countFact(facts: Fact[]): { value: string; unit: string } | null {
  const hit = facts.find((f) => COUNT_FACT_KEYS.includes(f.k));
  if (!hit) return null;
  return { value: hit.v, unit: hit.k.toLowerCase() };
}

// -- portal (this app) section -------------------------------------------------

export const POLL_OPTIONS = [
  { value: '30', label: 'every 30 seconds' },
  { value: '60', label: 'every 60 seconds' },
  { value: '120', label: 'every 2 minutes' },
  { value: '300', label: 'every 5 minutes' },
];

export const DENSITY_OPTIONS = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

/** Per-screen source override: Portal = follow the portal-wide demoMode. */
export const SOURCE_OPTIONS = [
  { value: 'auto', label: 'Portal' },
  { value: 'demo', label: 'Demo' },
  { value: 'live', label: 'Live' },
];

export const SECTION_LABEL: Record<ScreenSection, string> = {
  overview: 'Overview',
  alerts: 'Alerts',
  clients: 'Clients',
  authEvents: 'Auth events',
  sites: 'Sites',
  devices: 'Devices',
  licenses: 'Licenses',
  configure: 'Configure',
  compliance: 'Compliance',
  systems: 'Systems',
};
