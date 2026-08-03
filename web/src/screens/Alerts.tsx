/**
 * web/src/screens/Alerts.tsx — the de-duplicated queue across all planes.
 * High-fidelity port of design/NtAlerts.dc.html: danger correlation Alert,
 * filter row (FacetFilter popovers — severity, plane, site, each a checklist
 * with live counts, OR-within / AND-across — mono Input 230px,
 * "Unacknowledged only" Switch, right-aligned mono `N of M` count), open table
 * Sev/Alert/Site/Plane/State/Age/actions. Filters are local, instant and
 * additive (AND); an empty result shows the EmptyState.
 * The queue table is a nightdesk DataTable, following the Devices reference:
 * the column manager (View options dropdown + header-edge resize) persists
 * its controlled config through SettingsContext under the 'alerts' table id,
 * the rows are a keyboard grid (j/↓ k/↑ move, Enter/→ opens the group's
 * timeline drawer, x selects, Esc clears — '?' lists them), and the 'alert'
 * column is non-hideable because it is the row's primary identifier. Saved
 * views (the Views dropdown) capture the facet selection, free text, the two
 * switches, the column config and the density, named and persisted through
 * SettingsContext under the 'alerts' screen id. A row that arrived through
 * the inbound webhook receiver (shared/webhooks.ts WebhookAlertRow) carries a
 * small 'webhook' provenance badge beside its title — subtle, and only ever
 * present when the row genuinely carries source:'webhook'.
 * The banner is a served correlation when the payload carries one, else
 * authored prose for a demo-sourced queue and a correlation derived from the
 * rows for a live/blended one — by the SAME rule the server applies
 * (shared/logic.ts correlateAlerts), so the two can never name a different
 * worst finding; rows from a plane that is behind read `unverified`, never a
 * current age.
 * Rows are deduped by fingerprint (normalised plane+device+title —
 * shared/alertEngine.ts): a flapping alert renders once with a ×N badge, and
 * the count line counts FIRINGS, so a ×3 row is three of them. A group can be
 * silenced for a time-boxed window (1h/8h/24h/7d) with a required reason;
 * silenced groups leave the active table but are ALWAYS listed below it with
 * reason and expiry plus an Unsilence action — suppression is never invisible.
 * A silenced group hushed by a maintenance window says so instead of offering
 * an Unsilence that the scheduler would undo.
 * Every group also opens an occurrence Timeline drawer: fired → deduped ×N →
 * silenced (reason) → change committed, joined server-side from the queue,
 * the silence store, the device change log and config-backup drift
 * (/api/alerts/:fingerprint/timeline) — with at most one correlation
 * sentence, never a causal claim.
 * Below the queue, the Maintenance windows section schedules suppression
 * (shared/maintenanceWindows.ts): upcoming + active windows with their
 * matchers and spans, a create drawer (matchers + once/weekly schedule +
 * required reason), and enable/disable/delete. With the backend unreachable
 * the section falls back to the AUTHORED demo windows, labelled demo —
 * the same rule the queue's own fixture fallback follows.
 * The Device-down rules section manages the OTHER alert source: the engine
 * (shared/alertRules.ts) that watches for devices which stop reporting at
 * all — no plane raises an alert for those, so a rule does. Rules list with
 * an enabled switch and a scope/minutes summary, a create/edit drawer (site
 * filter, device-type select, offline/cooldown minutes with the 1–1440
 * bounds — the drawer's validation is the shared validateDeviceDownRule, the
 * same function the route runs), and delete behind a confirm drawer. Rules
 * are real operator data in BOTH demo and live mode (the engine evaluates
 * the demo estate in demo mode); with the backend unreachable the section
 * shows the AUTHORED demo rule, labelled, exactly like the windows.
 * Data: getAlerts() — live /api/alerts when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  DATATABLE_ROW_SHORTCUTS,
  DataTable,
  Drawer,
  EmptyState,
  FormField,
  Input,
  KeyboardShortcuts,
  Select,
  Spinner,
  Switch,
  TableViewOptions,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { ackAlert, createSilence, deleteSilence, getAlerts, getTickets, raiseTicket } from '../api/client';
import type { AlertsData } from '../api/client';
import { apiFetch, messageFromBody, responseJson } from '../api/core';
import { hhmmLocal as hhmm, correlateAlerts, groupAlerts, windowSpanAt, demoAlertTimeline, DEMO_MAINTENANCE_WINDOWS, DEMO_DEVICE_DOWN_RULE, DEVICE_TYPE_FILTERS, validateDeviceDownRule } from '@hpe/shared';
import type {
  AlertCorrelation,
  AlertGroup,
  AlertRow,
  AlertSilence,
  AlertTimeline,
  DeviceDownRule,
  DeviceDownRuleInput,
  DeviceTypeFilter,
  MaintenanceSchedule,
  MaintenanceWindow,
  MaintenanceWindowView,
  TicketRow,
} from '@hpe/shared';
import { useSettings } from '../app/SettingsContext';
import type { SavedView } from '../app/SettingsContext';
import { applyFacets, FacetFilter, sanitizeFacetSelection } from '../components/FacetFilter';
import type { FacetDef, FacetSelection } from '../components/FacetFilter';
import { SavedViews } from '../components/SavedViews';
import { deviceDetailPath } from '../app/nav';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';

/** The silence durations the drawer offers, in minutes. */
const SILENCE_DURATIONS = [
  { value: '60', label: '1 hour' },
  { value: '480', label: '8 hours' },
  { value: '1440', label: '24 hours' },
  { value: '10080', label: '7 days' },
];

/** The authored banner from design/NtAlerts.dc.html — demo fixtures only. */
const DEMO_BANNER: Banner = {
  tone: 'danger',
  title: 'Riverside Clinic is dark — and its plane is stale',
  body:
    'WAN down 12 minutes. Central Classic last synced 6h ago, so device state there cannot be ' +
    'trusted. The local collector still answers on 10.51.0.0/24 — inspect sw-riv-1 over SSH instead.',
};

interface Banner {
  /** The nightdesk Alert tones; `accent` is not one of them. */
  tone: 'danger' | 'warning' | 'info' | 'success' | 'neutral';
  title: string;
  body: string;
}

/**
 * A correlation in the Alert component's own vocabulary. `accent` is not one
 * of its tones, and a correlation that states no tone keeps the renderer's
 * historic default rather than inventing a calmer one.
 */
function bannerFrom(correlation: AlertCorrelation | null | undefined): Banner | null {
  if (!correlation || !correlation.title) return null;
  return {
    tone:
      correlation.tone && correlation.tone !== 'accent' ? correlation.tone : 'danger',
    title: correlation.title,
    body: correlation.body,
  };
}

/**
 * A correlation the SERVER computed, if the payload carries one. It outranks
 * the locally derived banner because it can see facts no alert row carries —
 * a plane's sync age, its call budget, the sections that failed to fetch.
 * The key is optional on the wire (and on `AlertsData`, which belongs to
 * another file), so it is read defensively: an absent or empty correlation
 * changes nothing, and a served one renders instead of a weaker banner
 * derived beside it.
 */
function servedBanner(data: AlertsData): Banner | null {
  return bannerFrom((data as AlertsData & { correlation?: AlertCorrelation | null }).correlation);
}

/**
 * Why a row cannot be cleared from the portal, in the plane's own vocabulary.
 * Mirrors server/src/services/ackAlert.ts:129-142 so the screen states the truth
 * BEFORE the operator picks a ticket rather than after a red 409 (design rule 4 —
 * read-only planes are honest, the portal offers a hand-off, never a fake form).
 * Null = the broker will accept this row.
 */
function ackBlocker(a: AlertRow): string | null {
  if (a.plane !== 'CENTRAL') {
    return a.plane === 'UXI'
      ? 'close it in the UXI dashboard — the sensor API is read-only from here'
      : `acknowledge it in the ${a.plane.toLowerCase()} console — that plane is read-only from here`;
  }
  if (!a.alertId) {
    return 'no plane key on record for this row — acknowledge it in Central';
  }
  return null;
}

/**
 * The row an action targeted vs a row in the flat list. Identical when the
 * screen grouped the rows itself; matched by plane key (or full fingerprint
 * fields) when the ROUTE grouped them, because a served group carries its own
 * copy of the latest firing. Used by the optimistic ack update, which must not
 * paint 'acked' onto the wrong row.
 */
function sameAlertRow(a: AlertRow, b: AlertRow): boolean {
  if (a === b) return true;
  if (a.alertId && b.alertId) return a.plane === b.plane && a.alertId === b.alertId;
  return a.plane === b.plane && a.title === b.title && a.device === b.device && a.age === b.age;
}

/** Firings across groups — a ×3 row is three of them, not one. */
function countFirings(groups: readonly AlertGroup[]): number {
  return groups.reduce((n, g) => n + g.count, 0);
}

/** Expiry stamp for a silence: hh:mm when it ends today, else day + time, in
 *  the reader's own clock — the same rule the evidence timestamps follow. */
function untilLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? hhmm(iso)
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Toast-safe rendering of an unknown thrown value. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The maintenance window a silence was materialized from, when the row says
 *  so — an additive key the shared AlertSilence type does not declare. */
function silenceWindowId(silence: AlertSilence): string | null {
  const tagged = (silence as { windowId?: unknown }).windowId;
  return typeof tagged === 'string' ? tagged : null;
}

/** A VIRTUAL fixture silence (maintenance demo window) — computed on read,
 *  never in the store, so there is nothing to unsilence. */
function isVirtualFixtureSilence(silence: AlertSilence): boolean {
  return silence.id.startsWith('mw-sil-');
}

/** The inbound-webhook provenance marker (shared/webhooks.ts WebhookAlertRow)
 *  — an additive key the base AlertRow type does not declare, read defensively
 *  so an older feed simply shows no badge. */
function isWebhookRow(a: AlertRow): boolean {
  return (a as { source?: unknown }).source === 'webhook';
}

// ---------------------------------------------------------------------------
// Maintenance windows, device-down rules + occurrence timeline API (small
// enough to live beside the only screen that calls them; the {error, offline}
// convention mirrors web/src/api/silences.ts).
// ---------------------------------------------------------------------------

type ApiFail = { error: string; offline?: boolean };

/** GET /api/maintenance-windows — every window on file, span-state annotated. */
async function fetchMaintenanceWindows(): Promise<{ windows: MaintenanceWindowView[] } | ApiFail> {
  try {
    const r = await apiFetch('/api/maintenance-windows');
    const body = (await responseJson(r)) as { windows?: MaintenanceWindowView[]; error?: string } | undefined;
    if (r.ok && body?.windows) return { windows: body.windows };
    return { error: messageFromBody(body, `HTTP ${r.status}`) };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** POST /api/maintenance-windows — create a window (audit-logged server-side). */
async function postMaintenanceWindow(input: {
  reason: string;
  matchers: MaintenanceWindow['matchers'];
  schedule: MaintenanceSchedule;
}): Promise<{ window: MaintenanceWindow } | ApiFail> {
  try {
    const r = await apiFetch('/api/maintenance-windows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await responseJson(r)) as { window?: MaintenanceWindow; error?: string } | undefined;
    if (r.ok && body?.window) return { window: body.window };
    return { error: messageFromBody(body, `HTTP ${r.status}`) };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** PATCH /api/maintenance-windows/:id — enable/disable (audit-logged). */
async function patchMaintenanceWindow(id: string, enabled: boolean): Promise<{ window: MaintenanceWindow } | ApiFail> {
  try {
    const r = await apiFetch(`/api/maintenance-windows/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const body = (await responseJson(r)) as { window?: MaintenanceWindow; error?: string } | undefined;
    if (r.ok && body?.window) return { window: body.window };
    return { error: messageFromBody(body, `HTTP ${r.status}`) };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** DELETE /api/maintenance-windows/:id — remove a window (audit-logged). */
async function removeMaintenanceWindow(id: string): Promise<{ ok: true } | ApiFail> {
  try {
    const r = await apiFetch(`/api/maintenance-windows/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = (await responseJson(r)) as { ok?: boolean; error?: string } | undefined;
    if (r.ok && body?.ok) return { ok: true };
    return { error: messageFromBody(body, `HTTP ${r.status}`) };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** GET /api/alert-rules — every device-down rule on file. */
async function fetchAlertRules(): Promise<{ rules: DeviceDownRule[] } | ApiFail> {
  try {
    const r = await apiFetch('/api/alert-rules');
    const body = (await responseJson(r)) as { rules?: DeviceDownRule[]; error?: string } | undefined;
    if (r.ok && body?.rules) return { rules: body.rules };
    return { error: messageFromBody(body, `HTTP ${r.status}`) };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** POST /api/alert-rules — create a rule (audit-logged server-side). */
async function postAlertRule(input: DeviceDownRuleInput): Promise<{ rule: DeviceDownRule } | ApiFail> {
  try {
    const r = await apiFetch('/api/alert-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await responseJson(r)) as { rule?: DeviceDownRule; error?: string } | undefined;
    if (r.ok && body?.rule) return { rule: body.rule };
    return { error: messageFromBody(body, `HTTP ${r.status}`) };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** PUT /api/alert-rules/:id — partial edit (audit-logged). */
async function putAlertRule(id: string, input: DeviceDownRuleInput): Promise<{ rule: DeviceDownRule } | ApiFail> {
  try {
    const r = await apiFetch(`/api/alert-rules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await responseJson(r)) as { rule?: DeviceDownRule; error?: string } | undefined;
    if (r.ok && body?.rule) return { rule: body.rule };
    return { error: messageFromBody(body, `HTTP ${r.status}`) };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** DELETE /api/alert-rules/:id — remove a rule (audit-logged). */
async function removeAlertRule(id: string): Promise<{ ok: true } | ApiFail> {
  try {
    const r = await apiFetch(`/api/alert-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = (await responseJson(r)) as { ok?: boolean; error?: string } | undefined;
    if (r.ok && body?.ok) return { ok: true };
    return { error: messageFromBody(body, `HTTP ${r.status}`) };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** GET /api/alerts/:fingerprint/timeline — the per-group occurrence join. */
async function fetchAlertTimeline(fingerprint: string): Promise<{ timeline: AlertTimeline } | ApiFail> {
  try {
    const r = await apiFetch(`/api/alerts/${encodeURIComponent(fingerprint)}/timeline`);
    const body = (await responseJson(r)) as { timeline?: AlertTimeline; error?: string } | undefined;
    if (r.ok && body?.timeline) return { timeline: body.timeline };
    return { error: messageFromBody(body, `HTTP ${r.status}`) };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** The authored demo windows as the GET route would annotate them — the
 *  offline fallback, so the section showcases without a backend. */
function demoWindowViews(): MaintenanceWindowView[] {
  const now = Date.now();
  return DEMO_MAINTENANCE_WINDOWS.map((w) => {
    const at = windowSpanAt(w, now);
    return {
      ...w,
      state: at.state,
      ...(at.state === 'expired'
        ? { expired: true }
        : { spanStart: new Date(at.span.start).toISOString(), spanEnd: new Date(at.span.end).toISOString() }),
      demo: true as const,
    };
  });
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'Aug 3, 02:00' in the reader's own clock. */
function fmtInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** One-line matcher summary for a window row. */
function matcherSummary(w: MaintenanceWindow): string {
  const parts: string[] = [];
  if (w.matchers.plane) parts.push(`plane ${w.matchers.plane}`);
  if (w.matchers.device) parts.push(`device ${w.matchers.device}`);
  if (w.matchers.site) parts.push(`site ${w.matchers.site}`);
  if (w.matchers.titleSubstring) parts.push(`title ~ "${w.matchers.titleSubstring}"`);
  return parts.join(' · ');
}

/** One-line scope + thresholds summary for a rule row — the same words the
 *  route's audit-log line (describeRule) uses, minus the verb. */
function ruleSummary(r: DeviceDownRule): string {
  const scope = `${r.deviceTypeFilter ?? 'all types'} · ${r.siteFilter ? `site ${r.siteFilter}` : 'all sites'}`;
  return `${scope} — alert after ${r.offlineMinutes}m offline · cooldown ${r.cooldownMinutes}m`;
}

/** Display labels for the device-type select; the stored value is the
 *  canonical filter word (shared/alertRules.ts DEVICE_TYPE_FILTERS). */
const DEVICE_TYPE_LABELS: Record<DeviceTypeFilter, string> = {
  all: 'All device types',
  switch: 'Switches',
  ap: 'Access points',
  gateway: 'Gateways',
};

/** One-line schedule summary for a window row, with the live span note. */
function scheduleSummary(w: MaintenanceWindowView): string {
  const s = w.schedule;
  const base =
    s.kind === 'once'
      ? `once · ${fmtInstant(s.start)} → ${fmtInstant(s.end)}`
      : `weekly · ${[...s.days].sort((a, b) => a - b).map((d) => DAY_LABELS[d] ?? '?').join(' ')} ${s.startTime}–${s.endTime}${s.tz ? ` ${s.tz}` : ''}`;
  if (w.state === 'active' && w.spanEnd) return `${base} · active, ends ${untilLabel(w.spanEnd)}`;
  if (w.state === 'upcoming' && w.spanStart) return `${base} · next ${untilLabel(w.spanStart)}`;
  return base;
}

/** Badge tone per timeline event kind. */
function timelineTone(kind: AlertTimeline['events'][number]['kind']): 'danger' | 'warning' | 'info' | 'success' | 'neutral' {
  if (kind === 'fired') return 'danger';
  if (kind === 'change') return 'info';
  if (kind === 'config-drift') return 'warning';
  return 'neutral';
}

/** Badge label per timeline event kind. */
function timelineKindLabel(kind: AlertTimeline['events'][number]['kind']): string {
  if (kind === 'silence-expired') return 'expired';
  if (kind === 'config-drift') return 'drift';
  return kind;
}

export default function Alerts() {
  const navigate = useNavigate();
  const { density, setDensity, showPlatformTags, pollIntervalSec, tableColumns, setTableColumns, savedViews, setSavedViews } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<AlertsData | null>(null);
  /* Faceted filtering (severity / plane / site) — OR within a facet, AND
   * across facets, composed with the free text and switches below. A
   * `?plane=` deep link (the Central screen's queue hand-off) seeds the
   * plane facet once, on mount; after that the selection is the operator's. */
  const [searchParams] = useSearchParams();
  const [facets, setFacets] = useState<FacetSelection>(() => {
    const plane = searchParams.get('plane')?.trim();
    const init: FacetSelection = plane ? { plane: [plane] } : {};
    return init;
  });
  const [q, setQ] = useState('');
  const [unackedOnly, setUnackedOnly] = useState(false);
  /* Row selection for the queue table's keyboard grid. Nothing on this
   * screen consumes the selection yet — it follows the Devices reference, and
   * the change-queue bulk-actions work will. */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Rows the plane itself considers resolved are not workload — they are out of
   * the queue unless the operator asks for them (shared/types.ts:274). */
  const [showCleared, setShowCleared] = useState(false);

  /* Ticket-gated acknowledge (Central's notifications clear API). The confirm
   * block lives inline under the header; it targets the first open alert in
   * the filtered view, snapshotted when the block opens. */
  const [ackTarget, setAckTarget] = useState<AlertRow | null>(null);
  const [ackTickets, setAckTickets] = useState<TicketRow[]>([]);
  const [ackTicket, setAckTicket] = useState('');
  const [ackBusy, setAckBusy] = useState(false);
  /* Distinguishes "still fetching" from "there is genuinely no open ticket" —
   * a fresh live install has none, and a greyed-out button with an empty Select
   * and no copy reads as a broken control. */
  const [ticketsLoaded, setTicketsLoaded] = useState(false);

  /* Time-boxed silence drawer: targets one group and always requires a
   * reason — it is audit-logged and shown wherever the group is hidden from. */
  const [silenceTarget, setSilenceTarget] = useState<AlertGroup | null>(null);
  const [silenceMinutes, setSilenceMinutes] = useState('480');
  const [silenceReason, setSilenceReason] = useState('');
  const [silenceBusy, setSilenceBusy] = useState(false);

  /* Maintenance windows: served when the backend answers; the AUTHORED demo
   * set (labelled) when it is unreachable; an honest error note when it
   * answered but failed. */
  const [windows, setWindows] = useState<MaintenanceWindowView[] | null>(null);
  const [windowsDemo, setWindowsDemo] = useState(false);
  const [windowsError, setWindowsError] = useState<string | null>(null);
  const [windowForm, setWindowForm] = useState(false);
  const [wReason, setWReason] = useState('');
  const [wPlane, setWPlane] = useState('');
  const [wDevice, setWDevice] = useState('');
  const [wSite, setWSite] = useState('');
  const [wTitle, setWTitle] = useState('');
  const [wKind, setWKind] = useState<'once' | 'weekly'>('weekly');
  const [wDays, setWDays] = useState<number[]>([6]);
  const [wStartTime, setWStartTime] = useState('02:00');
  const [wEndTime, setWEndTime] = useState('04:00');
  const [wOnceStart, setWOnceStart] = useState('');
  const [wOnceEnd, setWOnceEnd] = useState('');
  const [wTz, setWTz] = useState('');
  const [wBusy, setWBusy] = useState(false);

  /* Device-down rules: served when the backend answers; the AUTHORED demo
   * rule (labelled) when it is unreachable; an honest error note when it
   * answered but failed. Rules are real operator data in both demo and live
   * mode — the engine evaluates whichever estate the screen is showing. */
  const [rules, setRules] = useState<DeviceDownRule[] | null>(null);
  const [rulesDemo, setRulesDemo] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState(false);
  const [ruleEditing, setRuleEditing] = useState<DeviceDownRule | null>(null);
  const [rEnabled, setREnabled] = useState(true);
  const [rSite, setRSite] = useState('');
  const [rType, setRType] = useState<DeviceTypeFilter>('all');
  const [rOffline, setROffline] = useState('5');
  const [rCooldown, setRCooldown] = useState('60');
  const [rBusy, setRBusy] = useState(false);
  /* Delete goes through a confirm drawer — a deleted rule stops paging for
   * devices nothing else watches, so the click cannot be the decision. */
  const [ruleDelete, setRuleDelete] = useState<DeviceDownRule | null>(null);
  const [rDeleteBusy, setRDeleteBusy] = useState(false);

  /* Occurrence timeline drawer: one group's fired → silenced → changed
   * history, joined server-side per fingerprint. */
  const [timelineGroup, setTimelineGroup] = useState<AlertGroup | null>(null);
  const [timeline, setTimeline] = useState<AlertTimeline | null>(null);
  const [timelineNote, setTimelineNote] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);

  useEffect(() => {
    if (!ackTarget) return;
    let live = true;
    void getTickets().then((d) => {
      if (!live) return;
      const open = d.tickets.filter((t) => !/resolved|closed/i.test(t.state));
      const rest = d.tickets.filter((t) => /resolved|closed/i.test(t.state));
      const sorted = [...open, ...rest];
      setAckTickets(sorted);
      setAckTicket((curId) => curId || (sorted[0]?.id ?? ''));
      setTicketsLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [ackTarget]);

  /** Raise a ticket from an alert row; `goToQueue` follows it into /tickets. */
  const raiseFor = async (top: AlertRow, goToQueue: boolean): Promise<string | null> => {
    const r = await raiseTicket(top);
    if ('ticket' in r) {
      toast(`Ticket ${r.ticket.id} raised — ${top.title.slice(0, 48)}`, { tone: 'success' });
      if (goToQueue) navigate(`/tickets?sel=${encodeURIComponent(r.ticket.id)}`);
      return r.ticket.id;
    }
    toast(`Ticket raise unavailable (${r.error})${goToQueue ? ' — opening the queue' : ''}`, {
      tone: 'info',
    });
    if (goToQueue) navigate('/tickets');
    return null;
  };

  /** Re-read the queue so a just-raised ticket can authorise the acknowledge. */
  const reloadTickets = async (prefer: string | null) => {
    const d = await getTickets();
    const open = d.tickets.filter((t) => !/resolved|closed/i.test(t.state));
    const rest = d.tickets.filter((t) => /resolved|closed/i.test(t.state));
    const sorted = [...open, ...rest];
    setAckTickets(sorted);
    setAckTicket(prefer ?? sorted[0]?.id ?? '');
    setTicketsLoaded(true);
  };

  /**
   * `raiseFor`/`reloadTickets` both reach the network, so a transport failure
   * rejects rather than returning. Left unhandled that is an invisible
   * failure — the click looks like it did nothing. Say so instead.
   */
  const raiseFromTopRow = async () => {
    // Prefer an open row that names a device: site/tenant-class live
    // alerts are honestly device-less, and the raise route wants the
    // most specific evidence it can get.
    const top =
      rows.find((g) => g.latest.state === 'open' && g.latest.device.trim())?.latest ??
      rows.find((g) => g.latest.state === 'open')?.latest ??
      rows[0]?.latest;
    if (!top) {
      toast('No alert in view to raise from', { tone: 'info' });
      return;
    }
    try {
      await raiseFor(top, true);
    } catch (err) {
      toast('Ticket raise failed', { description: describeError(err), tone: 'danger' });
    }
  };

  const raiseFromAckTarget = async () => {
    if (!ackTarget) return;
    try {
      const id = await raiseFor(ackTarget, false);
      await reloadTickets(id);
    } catch (err) {
      toast('Ticket raise failed', { description: describeError(err), tone: 'danger' });
    }
  };

  const confirmAck = async () => {
    if (!ackTarget) return;
    if (!ackTicket) {
      toast('Pick the ticket that authorises this acknowledge — writes are brokered, never standing', {
        tone: 'danger',
      });
      return;
    }
    setAckBusy(true);
    const res = await ackAlert(
      {
        plane: ackTarget.plane,
        ...(ackTarget.alertId ? { alertId: ackTarget.alertId } : {}),
        title: ackTarget.title,
        device: ackTarget.device,
      },
      ackTicket,
    );
    setAckBusy(false);
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    // `cleared` is the server's re-read of the plane, and it is the only
    // thing that licenses the word "acknowledged". A 202 means Central agreed
    // to consider the request; showing the row as acked on the strength of
    // that is the same substitution the write broker is built to prevent,
    // except here the operator is looking straight at the row.
    const verified = res.applied && res.cleared === 'cleared';
    toast(
      !res.applied
        ? 'Acknowledge logged, not sent'
        : verified
          ? `Acknowledged — ${ackTarget.title.slice(0, 48)}`
          : `Accepted, not yet cleared — ${ackTarget.title.slice(0, 48)}`,
      { description: res.message, tone: verified ? 'success' : 'warning' },
    );
    if (verified) {
      // Central re-read confirms it — reflect it now rather than waiting for
      // the next poll. Anything less than confirmation leaves the row alone:
      // an alert still open is the accurate picture, and the poller will
      // correct it the moment it genuinely clears. Served groups carry their
      // own copy of the firing, so they are flipped alongside the flat rows.
      const target = ackTarget;
      const flip = (a: AlertRow) => (sameAlertRow(a, target) ? { ...a, state: 'acked' as const } : a);
      setData((d) =>
        d
          ? {
              ...d,
              alerts: d.alerts.map(flip),
              ...(d.groups
                ? { groups: d.groups.map((g) => ({ ...g, latest: flip(g.latest) })) }
                : {}),
            }
          : d,
      );
    }
    setAckTarget(null);
  };

  /* The header stamps SYNCED hh:mm, so a NOC tab must not sit on a mount-time
     snapshot under it: poll on the settings cadence, the same pattern
     Overview.tsx runs. One fetch at a time — a slow response never stacks up
     behind the interval; fixture reads poll harmlessly. */
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = () => {
      if (inFlight) return;
      inFlight = true;
      void getAlerts()
        .then((d) => {
          if (live) setData(d);
        })
        .finally(() => {
          inFlight = false;
        });
      // Windows ride the same cadence — a local read, cheap next to the queue.
      void fetchMaintenanceWindows().then((res) => {
        if (!live) return;
        if ('windows' in res) {
          setWindows(res.windows);
          setWindowsError(null);
          setWindowsDemo(false);
        } else if (res.offline) {
          setWindows(demoWindowViews());
          setWindowsError(null);
          setWindowsDemo(true);
        } else {
          setWindows(null);
          setWindowsError(res.error);
          setWindowsDemo(false);
        }
      });
      // So do the device-down rules — the same local read, the same demo
      // fallback rule (the AUTHORED demo rule, labelled).
      void fetchAlertRules().then((res) => {
        if (!live) return;
        if ('rules' in res) {
          setRules(res.rules);
          setRulesError(null);
          setRulesDemo(false);
        } else if (res.offline) {
          setRules([DEMO_DEVICE_DOWN_RULE]);
          setRulesError(null);
          setRulesDemo(true);
        } else {
          setRules(null);
          setRulesError(res.error);
          setRulesDemo(false);
        }
      });
    };
    pull();
    const every = Math.max(pollIntervalSec, 10) * 1000;
    const id = setInterval(pull, every);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pollIntervalSec]);

  /** Re-read the windows after a create/toggle/delete lands. */
  const refreshWindows = async () => {
    const res = await fetchMaintenanceWindows();
    if ('windows' in res) {
      setWindows(res.windows);
      setWindowsError(null);
      setWindowsDemo(false);
    } else if (res.offline) {
      setWindows(demoWindowViews());
      setWindowsError(null);
      setWindowsDemo(true);
    } else {
      setWindows(null);
      setWindowsError(res.error);
      setWindowsDemo(false);
    }
  };

  /** Re-read the rules after a create/update/delete lands. */
  const refreshRules = async () => {
    const res = await fetchAlertRules();
    if ('rules' in res) {
      setRules(res.rules);
      setRulesError(null);
      setRulesDemo(false);
    } else if (res.offline) {
      setRules([DEMO_DEVICE_DOWN_RULE]);
      setRulesError(null);
      setRulesDemo(true);
    } else {
      setRules(null);
      setRulesError(res.error);
      setRulesDemo(false);
    }
  };

  /* The timeline is fetched when its drawer opens — one join per open group,
   * never per poll. The reset lives in openTimeline (the event), so this
   * effect only talks to the network. Offline, the AUTHORED demo spine still
   * showcases the drawer for the fixture group, labelled as what it is. */
  useEffect(() => {
    if (!timelineGroup) return;
    let live = true;
    void fetchAlertTimeline(timelineGroup.fingerprint).then((res) => {
      if (!live) return;
      setTimelineLoading(false);
      if ('timeline' in res) {
        setTimeline(res.timeline);
        return;
      }
      if (res.offline) {
        const fixture = demoAlertTimeline(timelineGroup.fingerprint);
        if (fixture) {
          setTimeline({
            fingerprint: timelineGroup.fingerprint,
            device: timelineGroup.latest.device,
            events: fixture.events,
            ...(fixture.correlation ? { correlation: fixture.correlation } : {}),
          });
          setTimelineNote('backend unreachable — the authored demo timeline stands in, labelled');
          return;
        }
      }
      setTimelineNote(res.error);
    });
    return () => {
      live = false;
    };
  }, [timelineGroup]);

  /** Open the timeline drawer for a group — the previous group's content is
   *  cleared HERE (in the event), not in the fetch effect. */
  const openTimeline = (group: AlertGroup) => {
    setTimeline(null);
    setTimelineNote(null);
    setTimelineLoading(true);
    setTimelineGroup(group);
  };

  /** Re-read the queue after a silence lands or is lifted. */
  const refresh = async () => {
    setData(await getAlerts());
  };

  const confirmSilence = async () => {
    const target = silenceTarget;
    if (!target) return;
    const reason = silenceReason.trim();
    if (!reason) {
      toast('A silence needs a reason — it is shown wherever the group is hidden from', {
        tone: 'danger',
      });
      return;
    }
    const device = target.latest.device.trim();
    setSilenceBusy(true);
    const res = await createSilence({
      plane: target.latest.plane,
      ...(device && device !== '—' ? { device } : {}),
      titleContains: target.latest.title,
      reason,
      durationMinutes: Number(silenceMinutes),
    });
    setSilenceBusy(false);
    if (!('silence' in res)) {
      toast('Silence not created', { description: res.error, tone: 'danger' });
      return;
    }
    toast(`Silenced — ${target.latest.title.slice(0, 48)}`, {
      description: `${reason} · until ${untilLabel(res.silence.until)}`,
      tone: 'success',
    });
    setSilenceTarget(null);
    await refresh();
  };

  const unsilence = async (silence: AlertSilence, title: string) => {
    const res = await deleteSilence(silence.id);
    if (!('ok' in res)) {
      toast('Unsilence failed', { description: res.error, tone: 'danger' });
      return;
    }
    toast(`Unsilenced — ${title.slice(0, 48)}`, { tone: 'info' });
    await refresh();
  };

  /* Client-side mirror of the route's validation, so the drawer states the
   * problem BEFORE the round trip rather than after a red 400. */
  const windowFormError = (() => {
    if (!wReason.trim()) return 'a window needs a reason — it is stamped on every silence it raises';
    if (!wPlane.trim() && !wDevice.trim() && !wTitle.trim()) return 'at least one of plane, device or title substring';
    if (wKind === 'weekly') {
      if (wDays.length === 0) return 'pick at least one weekday';
      if (wStartTime === wEndTime) return 'start and end are the same — a window must have a length';
    } else {
      if (!wOnceStart || !wOnceEnd) return 'set both start and end';
      if (new Date(wOnceEnd).getTime() <= new Date(wOnceStart).getTime()) return 'the window must end after it starts';
    }
    return null;
  })();

  const openWindowForm = () => {
    setWReason('');
    setWPlane('');
    setWDevice('');
    setWSite('');
    setWTitle('');
    setWKind('weekly');
    setWDays([6]);
    setWStartTime('02:00');
    setWEndTime('04:00');
    setWOnceStart('');
    setWOnceEnd('');
    setWTz('');
    setWindowForm(true);
  };

  const toggleDay = (day: number) => {
    setWDays((cur) => (cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day].sort((a, b) => a - b)));
  };

  const createWindow = async () => {
    if (windowFormError) return;
    const schedule: MaintenanceSchedule =
      wKind === 'weekly'
        ? {
            kind: 'weekly',
            days: wDays,
            startTime: wStartTime,
            endTime: wEndTime,
            ...(wTz.trim() ? { tz: wTz.trim() } : {}),
          }
        : { kind: 'once', start: new Date(wOnceStart).toISOString(), end: new Date(wOnceEnd).toISOString() };
    setWBusy(true);
    const res = await postMaintenanceWindow({
      reason: wReason.trim(),
      matchers: {
        ...(wPlane.trim() ? { plane: wPlane.trim() } : {}),
        ...(wDevice.trim() ? { device: wDevice.trim() } : {}),
        ...(wSite.trim() ? { site: wSite.trim() } : {}),
        ...(wTitle.trim() ? { titleSubstring: wTitle.trim() } : {}),
      },
      schedule,
    });
    setWBusy(false);
    if (!('window' in res)) {
      toast('Window not created', { description: res.error, tone: 'danger' });
      return;
    }
    toast(`Window scheduled — ${res.window.reason.slice(0, 48)}`, { tone: 'success' });
    setWindowForm(false);
    await refreshWindows();
  };

  const toggleWindow = async (w: MaintenanceWindowView, enabled: boolean) => {
    const res = await patchMaintenanceWindow(w.id, enabled);
    if (!('window' in res)) {
      toast('Window not updated', { description: res.error, tone: 'danger' });
      return;
    }
    toast(`${enabled ? 'Enabled' : 'Disabled'} — ${w.reason.slice(0, 48)}`, { tone: 'info' });
    await refreshWindows();
  };

  const deleteWindow = async (w: MaintenanceWindowView) => {
    const res = await removeMaintenanceWindow(w.id);
    if (!('ok' in res)) {
      toast('Window not deleted', { description: res.error, tone: 'danger' });
      return;
    }
    toast(`Window deleted — ${w.reason.slice(0, 48)}`, { tone: 'info' });
    await refreshWindows();
  };

  /* Client-side mirror of the route's rule validation — literally the shared
   * validateDeviceDownRule the route runs, so the drawer names the problem
   * BEFORE the round trip with the same words the 400 would use. Blank
   * minutes are "required" here rather than "invalid": the route's defaults
   * apply to ABSENT fields, and a drawer the operator emptied is not absent. */
  const ruleFormError = (() => {
    if (!rOffline.trim() || !rCooldown.trim()) return 'offline and cooldown minutes are both required';
    const errors = validateDeviceDownRule({
      offlineMinutes: Number(rOffline),
      cooldownMinutes: Number(rCooldown),
      ...(rSite.trim() ? { siteFilter: rSite.trim() } : {}),
    });
    return errors[0] ?? null;
  })();

  const openRuleForm = (rule: DeviceDownRule | null) => {
    setRuleEditing(rule);
    setREnabled(rule?.enabled ?? true);
    setRSite(rule?.siteFilter ?? '');
    setRType(rule?.deviceTypeFilter ?? 'all');
    setROffline(String(rule?.offlineMinutes ?? 5));
    setRCooldown(String(rule?.cooldownMinutes ?? 60));
    setRuleForm(true);
  };

  const saveRule = async () => {
    if (ruleFormError) return;
    const base = {
      enabled: rEnabled,
      deviceTypeFilter: rType,
      offlineMinutes: Number(rOffline),
      cooldownMinutes: Number(rCooldown),
    };
    setRBusy(true);
    // The site filter's tri-state: on edit a blank field must CLEAR the
    // narrowing (null), not leave it; on create it is simply omitted.
    const res = ruleEditing
      ? await putAlertRule(ruleEditing.id, { ...base, siteFilter: rSite.trim() ? rSite.trim() : null })
      : await postAlertRule({ ...base, ...(rSite.trim() ? { siteFilter: rSite.trim() } : {}) });
    setRBusy(false);
    if (!('rule' in res)) {
      toast(ruleEditing ? 'Rule not saved' : 'Rule not created', { description: res.error, tone: 'danger' });
      return;
    }
    toast(ruleEditing ? 'Rule updated' : 'Rule created', { description: ruleSummary(res.rule), tone: 'success' });
    setRuleForm(false);
    setRuleEditing(null);
    await refreshRules();
  };

  const toggleRule = async (r: DeviceDownRule, enabled: boolean) => {
    const res = await putAlertRule(r.id, { enabled });
    if (!('rule' in res)) {
      toast('Rule not updated', { description: res.error, tone: 'danger' });
      return;
    }
    toast(`${enabled ? 'Enabled' : 'Disabled'} — ${ruleSummary(res.rule)}`, { tone: 'info' });
    await refreshRules();
  };

  const confirmDeleteRule = async () => {
    const target = ruleDelete;
    if (!target) return;
    setRDeleteBusy(true);
    const res = await removeAlertRule(target.id);
    setRDeleteBusy(false);
    if (!('ok' in res)) {
      toast('Rule not deleted', { description: res.error, tone: 'danger' });
      return;
    }
    toast(`Rule deleted — ${ruleSummary(target)}`, { tone: 'info' });
    setRuleDelete(null);
    await refreshRules();
  };

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const ql = q.trim().toLowerCase();
  /* The deduped queue: served groups when the route grouped them, else the
   * same shared engine over the flat rows (the demo fixture fallback). Either
   * way a group renders its latest firing with a ×N badge for the rest, and
   * silenced groups are never here — they are listed below the table. */
  const groups = data.groups ?? groupAlerts(data.alerts);
  const silencedGroups = data.silenced ?? [];
  /* The facet universe: every group the NON-facet filters (cleared rule,
     unacked switch, free text) let through. The FacetFilter counts describe
     this set, and applyFacets narrows it to the rows the table shows — so a
     count never promises rows the search box would then hide. */
  const baseRows = groups.filter(
    (g) =>
      (showCleared || g.latest.state !== 'cleared') &&
      (!unackedOnly || g.latest.state === 'open') &&
      (!ql || (g.latest.title + g.latest.detail + g.latest.siteName).toLowerCase().includes(ql)),
  );
  const alertFacets: Array<FacetDef<AlertGroup>> = [
    { key: 'sev', label: 'Severity', values: (g) => [g.latest.sev] },
    { key: 'plane', label: 'Plane', values: (g) => [g.latest.plane] },
    {
      key: 'site',
      label: 'Site',
      values: (g) => [g.latest.siteId],
      formatValue: (id) => groups.find((g) => g.latest.siteId === id)?.latest.siteName ?? id,
    },
  ];
  const rows = applyFacets(baseRows, alertFacets, facets);
  /* The denominator is the queue, and a row the plane already resolved is not in
   * it — counting cleared rows overstates the workload (README §2). Counts are
   * in firings: a ×3 group is three of them, not one. */
  const clearedCount = countFirings(groups.filter((g) => g.latest.state === 'cleared'));
  const queueTotal = showCleared ? countFirings(groups) : countFirings(groups) - clearedCount;

  /* A saved view snapshots the facet selection, the free text and both
     switches, the column-manager config and the density — applying one
     restores all of it. */
  const captureView = (): Omit<SavedView, 'name'> => ({
    filters: { facets, q, unackedOnly, showCleared },
    tableColumns: tableColumns.alerts ?? {},
    density,
  });
  const applyView = (view: SavedView) => {
    const f = view.filters as { facets?: unknown; q?: unknown; unackedOnly?: unknown; showCleared?: unknown };
    setFacets(sanitizeFacetSelection(f.facets));
    setQ(typeof f.q === 'string' ? f.q : '');
    setUnackedOnly(f.unackedOnly === true);
    setShowCleared(f.showCleared === true);
    if (view.tableColumns) setTableColumns('alerts', view.tableColumns);
    if (view.density) setDensity(view.density);
  };

  /* The queue table's column definitions, following the Devices reference:
     stable keys the column manager persists against under the 'alerts' table
     id; 'alert' is non-hideable as the row's primary identifier; no column
     carries a tint — nothing here has a meaningful threshold. */
  const alertColumns: Array<DataTableColumn<AlertGroup>> = [
    {
      key: 'sev',
      title: 'Sev',
      width: 76,
      render: (g) => (
        <Badge tone={g.latest.tone} dot>
          {g.latest.sev}
        </Badge>
      ),
    },
    {
      key: 'alert',
      title: 'Alert',
      hideable: false,
      render: (g) => {
        const a = g.latest;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>{a.title}</span>
              {/* One problem, N firings — the count is the noise level,
                  never N rows of the same thing. */}
              {g.count > 1 ? <Badge tone="neutral">×{g.count}</Badge> : null}
              {/* Inbound-webhook provenance: the row arrived through the
                  receiver, not a plane poll — said subtly, said honestly. */}
              {isWebhookRow(a) ? (
                <span title="received through an inbound webhook, not a plane poll">
                  <Badge tone="neutral">webhook</Badge>
                </span>
              ) : null}
            </span>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 10.5,
                color: 'var(--nd-text-muted)',
              }}
            >
              {g.count > 1 ? `${a.detail} · ${g.count} firings, first seen ${g.firstSeen} ago` : a.detail}
            </span>
          </div>
        );
      },
    },
    { key: 'site', title: 'Site', render: (g) => g.latest.siteName },
    {
      key: 'plane',
      title: 'Plane',
      render: (g) => {
        const a = g.latest;
        return (
          /* A row from a plane that is behind carries the design-rule-1
             marker next to its plane badge — unverified, not current. */
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {showPlatformTags ? <Badge tone="neutral">{a.plane}</Badge> : null}
            {a.stale ? (
              <Badge tone="warning" dot>
                stale
              </Badge>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'state',
      title: 'State',
      render: (g) => (
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color:
              g.latest.state === 'open' ? 'var(--nd-text-secondary)' : 'var(--nd-text-muted)',
          }}
        >
          {g.latest.state}
        </span>
      ),
    },
    {
      key: 'age',
      title: 'Age',
      numeric: true,
      render: (g) =>
        g.latest.stale ? (
          <span style={{ color: 'var(--nd-text-muted)' }}>{g.latest.age} · unverified</span>
        ) : (
          g.latest.age
        ),
    },
    {
      key: 'actions',
      title: 'Actions',
      header: '',
      render: (g) => {
        const a = g.latest;
        return (
          /* Site/WAN/tenant-class live alerts honestly name no device
             (central.ts:407-410) — Inspect would drop the operator on the
             full inventory, so say so instead of offering a dead action. */
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {a.device && a.device !== '—' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(deviceDetailPath({ name: a.device, plane: a.plane }))}
              >
                Inspect
              </Button>
            ) : (
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: 'var(--nd-text-muted)',
                }}
              >
                no device
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSilenceReason('');
                setSilenceMinutes('480');
                setSilenceTarget(g);
              }}
            >
              Silence
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openTimeline(g)}>
              Timeline
            </Button>
          </span>
        );
      },
    },
  ];

  /* Provenance: the section leads with real rows when the portal is live OR when
   * blend mode swapped this section in (README — the envelope's `blended` list). */
  const sectionLive = data.dataSource === 'live' || (data.blended?.includes('alerts') ?? false);
  const synced = sectionLive ? `SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : '—'}` : 'SYNCED 09:41';
  const banner =
    servedBanner(data) ??
    (sectionLive ? bannerFrom(correlateAlerts(data.alerts)) : DEMO_BANNER);
  // Linked planes whose alert read never came back. An empty queue is the
  // most dangerous empty state in the portal — it reads as all-clear — so a
  // queue that is merely unread must never be allowed to look like a quiet one.
  const missingSources = data.missingSources ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Operate / Alerts"
        title="Alerts"
        subtitle="Every plane's alarms in one queue, de-duplicated and aged."
        actions={
          <>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-10)',
                color: 'var(--nd-text-muted)',
                letterSpacing: '.08em',
              }}
            >
              {synced}
            </span>
            {data.blended?.includes('alerts') ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // A live queue is mostly rows the broker will refuse (ackAlert.ts
                // is Central-with-a-plane-key only), so target one it will accept
                // and hand off honestly when there is none — never open a confirm
                // block that can only end in a 409.
                const open = rows.filter((g) => g.latest.state === 'open').map((g) => g.latest);
                if (open.length === 0) {
                  toast('No open alert in view to acknowledge', { tone: 'info' });
                  return;
                }
                const top = sectionLive ? open.find((a) => !ackBlocker(a)) : open[0];
                if (!top) {
                  const first = open[0];
                  toast(`${first.plane} alerts cannot be cleared from here`, {
                    tone: 'info',
                    description: ackBlocker(first) ?? undefined,
                  });
                  return;
                }
                setTicketsLoaded(false);
                setAckTarget(top);
              }}
            >
              Acknowledge
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void raiseFromTopRow()}
            >
              Raise ticket
            </Button>
          </>
        }
      />

      {missingSources.length > 0 ? (
        <Alert
          tone="warning"
          title={`This queue is missing ${missingSources.length} linked source${
            missingSources.length === 1 ? '' : 's'
          }: ${missingSources.join(', ')}`}
        >
          <span style={{ fontSize: 13 }}>
            These planes are linked but their alert read has not come back, so anything open on them is absent from the
            queue below — including anything P1. A short queue here is not a quiet estate. Check them in Connected
            systems.
          </span>
        </Alert>
      ) : null}

      {banner ? (
        <Alert tone={banner.tone} title={banner.title}>
          <span style={{ fontSize: 13 }}>{banner.body}</span>
        </Alert>
      ) : null}

      {ackTarget ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 10,
            flexWrap: 'wrap',
            padding: '12px 14px',
            border: '1px solid var(--nd-border-default)',
            background: 'var(--nd-bg-raised)',
          }}
        >
          <div style={{ flex: 1, minWidth: 240 }}>
            <FormField
              label="Authorising ticket"
              help={
                sectionLive
                  ? `Clears "${ackTarget.title.slice(0, 64)}" on Central via the notifications API (202 = accepted); recorded against this ticket.`
                  : `Demo mode — the acknowledge is validated and audit-logged against this ticket; nothing is sent to ${ackTarget.plane}.`
              }
            >
              {ticketsLoaded && ackTickets.length === 0 ? (
                <span
                  style={{
                    display: 'block',
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-text-muted)',
                    lineHeight: 1.6,
                    paddingTop: 4,
                  }}
                >
                  No open ticket to authorise this acknowledge — writes are brokered, never
                  standing. Raise one from this alert first.
                </span>
              ) : (
                <Select
                  options={ackTickets.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))}
                  value={ackTicket}
                  onValueChange={setAckTicket}
                  aria-label="Authorising ticket"
                />
              )}
            </FormField>
          </div>
          {ticketsLoaded && ackTickets.length === 0 ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void raiseFromAckTarget()}
            >
              Raise ticket from this alert
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={ackBusy || !ackTicket}
              onClick={() => void confirmAck()}
            >
              {ackBusy ? 'Acknowledging…' : 'Acknowledge'}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setAckTarget(null)}>
            Cancel
          </Button>
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          paddingBottom: 4,
        }}
      >
        <FacetFilter facets={alertFacets} rows={baseRows} selection={facets} onChange={setFacets} />
        <div style={{ width: 230 }}>
          <Input
            size="sm"
            mono
            placeholder="filter text…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter alerts"
          />
        </div>
        <Switch
          label="Unacknowledged only"
          size="sm"
          checked={unackedOnly}
          onCheckedChange={setUnackedOnly}
        />
        {clearedCount > 0 ? (
          <Switch
            label="Include cleared"
            size="sm"
            checked={showCleared}
            onCheckedChange={setShowCleared}
          />
        ) : null}
        <SavedViews
          views={savedViews.alerts ?? []}
          capture={captureView}
          onApply={applyView}
          onChange={(views) => setSavedViews('alerts', views)}
        />
        <TableViewOptions
          columns={alertColumns}
          config={tableColumns.alerts ?? {}}
          onChange={(config) => setTableColumns('alerts', config)}
        />
        <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-muted)',
          }}
        >
          {`${countFirings(rows)} of ${queueTotal} alerts${
            clearedCount > 0 && !showCleared ? ` · ${clearedCount} cleared hidden` : ''
          }${silencedGroups.length > 0 ? ` · ${silencedGroups.length} silenced` : ''} · ${
            sectionLive ? 'live' : 'demo fixtures'
          }`}
        </span>
      </div>

      <DataTable
        ariaLabel="Alerts"
        density={density}
        columns={alertColumns}
        rows={rows}
        rowKey={(g) => g.fingerprint}
        columnsConfig={tableColumns.alerts}
        onColumnsConfigChange={(config) => setTableColumns('alerts', config)}
        onRowActivate={(g) => openTimeline(g)}
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
      />

      {/* An empty queue and an empty filter result are different facts: blaming
          a filter the operator never set implies alerts exist and are hidden.
          A queue emptied by SILENCES is a third fact — hushed, not quiet. */}
      {rows.length === 0 ? (
        data.alerts.length === 0 ? (
          silencedGroups.length > 0 ? (
            <EmptyState
              title="Everything firing is silenced"
              description="The queue is hushed, not quiet — the silenced groups below are still firing and return when their silence expires."
            />
          ) : (
            <EmptyState
              title={missingSources.length > 0 ? 'No alerts from the planes that answered' : 'No alerts in the queue'}
              description={
                sectionLive
                  ? missingSources.length > 0
                    ? // "Nothing is open across the linked planes" would be a
                      // claim about planes that never answered. The empty queue
                      // is only evidence about the ones that did.
                      `Nothing is open on the planes that reported. ${missingSources.join(', ')} did not answer, so this is not an all-clear.`
                    : data.syncedAt
                      ? 'Nothing is open across the linked planes as of the last poll.'
                      : 'No plane has reported yet — link one under Connected systems.'
                  : 'Nothing is open across the linked planes.'
              }
            >
              {sectionLive && !data.syncedAt ? (
                <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                  Connected systems
                </Button>
              ) : null}
            </EmptyState>
          )
        ) : (
          <EmptyState
            title="Nothing matches that filter"
            description="Loosen the search or the severity, plane and site facets to see the rest of the queue."
          />
        )
      ) : null}

      {/* Suppression is always visible: every group an active silence benched,
          with the reason and expiry, and a way back. */}
      {silencedGroups.length > 0 ? (
        <div
          style={{
            border: '1px solid var(--nd-border-default)',
            background: 'var(--nd-bg-raised)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              flexWrap: 'wrap',
              padding: '10px 14px',
              borderBottom: '1px solid var(--nd-border-default)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-secondary)',
                letterSpacing: '.08em',
              }}
            >
              {`SILENCED (${silencedGroups.length})`}
            </span>
            <span style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>
              benched from the active queue until the silence expires — never hidden
            </span>
          </div>
          {silencedGroups.map(({ group, silence }) => (
            <div
              key={silence.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '8px 14px',
              }}
            >
              <Badge tone={group.latest.tone} dot>
                {group.latest.sev}
              </Badge>
              <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>{group.latest.title}</span>
              {group.count > 1 ? <Badge tone="neutral">×{group.count}</Badge> : null}
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: 'var(--nd-text-muted)',
                }}
              >
                {silenceWindowId(silence)
                  ? `maintenance window ${silenceWindowId(silence)} · ${silence.reason} · until ${untilLabel(silence.until)}`
                  : `${silence.reason} · until ${untilLabel(silence.until)}`}
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Button variant="ghost" size="sm" onClick={() => openTimeline(group)}>
                  Timeline
                </Button>
                {/* A virtual fixture silence is not in the store — there is
                    nothing to delete; disabling the fixture window is the way. */}
                {isVirtualFixtureSilence(silence) ? (
                  <Badge tone="neutral">demo fixture</Badge>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => void unsilence(silence, group.latest.title)}>
                    Unsilence
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Device-down rules: the queue watches what planes REPORT; these rules
          watch for devices that stop reporting at all. Created/edited/deleted
          here, always listed with their scope and thresholds — and with the
          backend unreachable the AUTHORED demo rule stands in, labelled. */}
      <div
        style={{
          border: '1px solid var(--nd-border-default)',
          background: 'var(--nd-bg-raised)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            flexWrap: 'wrap',
            padding: '10px 14px',
            borderBottom: '1px solid var(--nd-border-default)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-secondary)',
              letterSpacing: '.08em',
            }}
          >
            {`DEVICE-DOWN RULES${rules ? ` (${rules.length})` : ''}`}
          </span>
          <span style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>
            a device that stops reporting raises no plane alert — these rules watch for it
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <Button variant="secondary" size="sm" onClick={() => openRuleForm(null)} disabled={rulesDemo}>
              New rule
            </Button>
          </span>
        </div>
        {rulesDemo ? (
          <div
            style={{
              padding: '8px 14px',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-muted)',
              borderBottom: '1px solid var(--nd-border-default)',
            }}
          >
            demo fixture — the backend is unreachable, so the authored demo rule stands in; creating or
            changing a rule needs the server
          </div>
        ) : null}
        {rulesError ? (
          <div
            style={{
              padding: '8px 14px',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-muted)',
              borderBottom: '1px solid var(--nd-border-default)',
            }}
          >
            {`device-down rules unavailable — ${rulesError}`}
          </div>
        ) : null}
        {rules?.map((r) => (
          <div
            key={r.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              padding: '8px 14px',
              opacity: r.enabled ? 1 : 0.55,
            }}
          >
            {/* The demo rule is authored, not a row in the store — there is
                nothing to toggle, edit or delete. */}
            {rulesDemo ? null : (
              <Switch
                size="sm"
                checked={r.enabled}
                onCheckedChange={(v) => void toggleRule(r, v)}
                aria-label={`Enable rule: ${ruleSummary(r)}`}
              />
            )}
            <Badge tone="neutral">{DEVICE_TYPE_LABELS[r.deviceTypeFilter ?? 'all']}</Badge>
            <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>
              {r.siteFilter ?? 'all sites'}
            </span>
            {rulesDemo ? <Badge tone="neutral">demo</Badge> : null}
            {r.enabled ? null : <Badge tone="neutral">disabled</Badge>}
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {`alert after ${r.offlineMinutes}m offline · cooldown ${r.cooldownMinutes}m`}
            </span>
            {rulesDemo ? null : (
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Button variant="ghost" size="sm" onClick={() => openRuleForm(r)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRuleDelete(r)}>
                  Delete
                </Button>
              </span>
            )}
          </div>
        ))}
        {rules && rules.length === 0 && !rulesError ? (
          <div
            style={{
              padding: '10px 14px',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-muted)',
            }}
          >
            No device-down rules — a device that stops reporting raises nothing until one watches it.
          </div>
        ) : null}
      </div>

      {/* Scheduled suppression: windows materialize ordinary silences while
          they are active — created here, enabled/disabled/deleted here, and
          always listed with their matchers and span so the calendar never
          hushes the queue invisibly. */}
      <div
        style={{
          border: '1px solid var(--nd-border-default)',
          background: 'var(--nd-bg-raised)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            flexWrap: 'wrap',
            padding: '10px 14px',
            borderBottom: '1px solid var(--nd-border-default)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-secondary)',
              letterSpacing: '.08em',
            }}
          >
            {`MAINTENANCE WINDOWS${windows ? ` (${windows.length})` : ''}`}
          </span>
          <span style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>
            scheduled suppression — an active window silences its matches with the reason stamped
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <Button variant="secondary" size="sm" onClick={openWindowForm} disabled={windowsDemo}>
              New window
            </Button>
          </span>
        </div>
        {windowsDemo ? (
          <div
            style={{
              padding: '8px 14px',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-muted)',
              borderBottom: '1px solid var(--nd-border-default)',
            }}
          >
            demo fixtures — the backend is unreachable, so these authored windows stand in; creating or
            changing one needs the server
          </div>
        ) : null}
        {windowsError ? (
          <div
            style={{
              padding: '8px 14px',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-muted)',
              borderBottom: '1px solid var(--nd-border-default)',
            }}
          >
            {`maintenance windows unavailable — ${windowsError}`}
          </div>
        ) : null}
        {windows?.map((w) => (
          <div
            key={w.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              padding: '8px 14px',
              opacity: w.enabled ? 1 : 0.55,
            }}
          >
            <Badge tone={w.state === 'active' ? 'success' : w.state === 'upcoming' ? 'info' : 'neutral'} dot>
              {w.state}
            </Badge>
            <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>{w.reason}</span>
            {w.demo ? <Badge tone="neutral">demo</Badge> : null}
            {w.enabled ? null : <Badge tone="neutral">disabled</Badge>}
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {matcherSummary(w)}
            </span>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {scheduleSummary(w)}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Fixture windows are authored, not rows in the store — there is
                  nothing to toggle or delete. */}
              {w.demo ? null : (
                <>
                  <Switch
                    size="sm"
                    checked={w.enabled}
                    onCheckedChange={(v) => void toggleWindow(w, v)}
                    aria-label={`Enable window: ${w.reason}`}
                  />
                  <Button variant="ghost" size="sm" onClick={() => void deleteWindow(w)}>
                    Delete
                  </Button>
                </>
              )}
            </span>
          </div>
        ))}
        {windows && windows.length === 0 && !windowsError ? (
          <div
            style={{
              padding: '10px 14px',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-muted)',
            }}
          >
            No maintenance windows — the queue hushes only for ad-hoc silences.
          </div>
        ) : null}
      </div>

      <Drawer
        open={silenceTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSilenceTarget(null);
        }}
        title="Silence alert group"
        description={
          silenceTarget
            ? `${silenceTarget.latest.title} · ${silenceTarget.latest.plane}${
                silenceTarget.latest.device && silenceTarget.latest.device !== '—'
                  ? ` · ${silenceTarget.latest.device}`
                  : ''
              }`
            : undefined
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <FormField
            label="Duration"
            help="The group leaves the active queue until then — and stays listed under Silenced with its reason, so suppression is never invisible."
          >
            <Select
              options={SILENCE_DURATIONS}
              value={silenceMinutes}
              onValueChange={setSilenceMinutes}
              aria-label="Silence duration"
            />
          </FormField>
          <FormField label="Reason" help="Required — audit-logged, and shown next to the silenced group.">
            <Input
              value={silenceReason}
              onChange={(e) => setSilenceReason(e.target.value)}
              placeholder="e.g. ISP maintenance window, ticket NET-4211"
              aria-label="Silence reason"
            />
          </FormField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => setSilenceTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={silenceBusy || !silenceReason.trim()}
              onClick={() => void confirmSilence()}
            >
              {silenceBusy ? 'Silencing…' : 'Silence'}
            </Button>
          </div>
        </div>
      </Drawer>

      {/* New maintenance window — matchers + a once/weekly schedule + the
          required reason. The route re-validates everything; the inline error
          below mirrors it so the mistake is named before the round trip. */}
      <Drawer
        open={windowForm}
        onOpenChange={(open) => {
          if (!open) setWindowForm(false);
        }}
        title="Schedule a maintenance window"
        description="While the window is active, matching alert groups are silenced — reason stamped, expiry automatic, suppression always listed."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <FormField label="Reason" help="Required — stamped on every silence this window raises, and audit-logged.">
            <Input
              value={wReason}
              onChange={(e) => setWReason(e.target.value)}
              placeholder="e.g. ISP cutover, ticket NET-4211"
              aria-label="Window reason"
            />
          </FormField>
          <FormField
            label="Matchers"
            help="At least one of plane, device or title substring — every set matcher must hold. Site narrows a matcher; it cannot stand alone."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Input mono value={wPlane} onChange={(e) => setWPlane(e.target.value)} placeholder="plane — e.g. MIST" aria-label="Plane matcher" />
              <Input mono value={wDevice} onChange={(e) => setWDevice(e.target.value)} placeholder="device — e.g. ap-3f-12" aria-label="Device matcher" />
              <Input mono value={wSite} onChange={(e) => setWSite(e.target.value)} placeholder="site — e.g. Campus-02 Research" aria-label="Site matcher" />
              <Input mono value={wTitle} onChange={(e) => setWTitle(e.target.value)} placeholder="title contains — e.g. firmware" aria-label="Title matcher" />
            </div>
          </FormField>
          <FormField label="Schedule" help="RRULE-lite: one fixed span, or the same wall-clock span on named weekdays.">
            <Select
              options={[
                { value: 'weekly', label: 'Weekly — same time on named weekdays' },
                { value: 'once', label: 'Once — one fixed span' },
              ]}
              value={wKind}
              onValueChange={(v) => setWKind(v === 'once' ? 'once' : 'weekly')}
              aria-label="Schedule kind"
            />
          </FormField>
          {wKind === 'weekly' ? (
            <>
              <FormField label="Weekdays">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {DAY_LABELS.map((label, i) => (
                    <Button
                      key={label}
                      size="sm"
                      variant={wDays.includes(i) ? 'primary' : 'secondary'}
                      onClick={() => toggleDay(i)}
                      aria-pressed={wDays.includes(i)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </FormField>
              <FormField label="From / to" help="'HH:MM' wall time — an end earlier than the start runs into the next day.">
                <div style={{ display: 'flex', gap: 8 }}>
                  <Input type="time" value={wStartTime} onChange={(e) => setWStartTime(e.target.value)} aria-label="Start time" />
                  <Input type="time" value={wEndTime} onChange={(e) => setWEndTime(e.target.value)} aria-label="End time" />
                </div>
              </FormField>
              <FormField label="Time zone" help="Optional IANA zone (e.g. Europe/London) — blank uses the server's local zone.">
                <Input mono value={wTz} onChange={(e) => setWTz(e.target.value)} placeholder="local" aria-label="Time zone" />
              </FormField>
            </>
          ) : (
            <FormField label="Start / end" help="One fixed span, in your local time.">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Input type="datetime-local" value={wOnceStart} onChange={(e) => setWOnceStart(e.target.value)} aria-label="Start" />
                <Input type="datetime-local" value={wOnceEnd} onChange={(e) => setWOnceEnd(e.target.value)} aria-label="End" />
              </div>
            </FormField>
          )}
          {windowFormError ? (
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {windowFormError}
            </span>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => setWindowForm(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={wBusy || windowFormError !== null} onClick={() => void createWindow()}>
              {wBusy ? 'Scheduling…' : 'Schedule window'}
            </Button>
          </div>
        </div>
      </Drawer>

      {/* New / edit device-down rule — scope (site + device type) and the two
          thresholds. The inline error is the shared validateDeviceDownRule,
          the same function the route runs, so the refusal reads identically
          before and after the round trip. */}
      <Drawer
        open={ruleForm}
        onOpenChange={(open) => {
          if (!open) {
            setRuleForm(false);
            setRuleEditing(null);
          }
        }}
        title={ruleEditing ? 'Edit device-down rule' : 'New device-down rule'}
        description="A device that stops reporting raises no plane alert — a matching rule fires instead, once per outage, after the offline threshold."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <FormField label="Site filter" help="Site name or id, matched case-insensitively — blank watches every site.">
            <Input
              mono
              value={rSite}
              onChange={(e) => setRSite(e.target.value)}
              placeholder="e.g. Campus-01 HQ"
              aria-label="Site filter"
            />
          </FormField>
          <FormField label="Device type" help="Which device types the rule speaks for.">
            <Select
              options={DEVICE_TYPE_FILTERS.map((v) => ({ value: v, label: DEVICE_TYPE_LABELS[v] }))}
              value={rType}
              onValueChange={(v) => setRType(v as DeviceTypeFilter)}
              aria-label="Device type filter"
            />
          </FormField>
          <FormField label="Offline minutes" help="How long a device must be continuously down before the rule fires — 1 to 1440 (24h). Default 5.">
            <Input
              type="number"
              min={1}
              max={1440}
              mono
              value={rOffline}
              onChange={(e) => setROffline(e.target.value)}
              aria-label="Offline minutes"
            />
          </FormField>
          <FormField label="Cooldown minutes" help="Quiet time after one alert before a different outage of the same device pages again — 1 to 1440 (24h). Default 60.">
            <Input
              type="number"
              min={1}
              max={1440}
              mono
              value={rCooldown}
              onChange={(e) => setRCooldown(e.target.value)}
              aria-label="Cooldown minutes"
            />
          </FormField>
          <Switch
            label="Enabled"
            size="sm"
            checked={rEnabled}
            onCheckedChange={setREnabled}
          />
          {ruleFormError ? (
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {ruleFormError}
            </span>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRuleForm(false);
                setRuleEditing(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={rBusy || ruleFormError !== null} onClick={() => void saveRule()}>
              {rBusy ? 'Saving…' : ruleEditing ? 'Save rule' : 'Create rule'}
            </Button>
          </div>
        </div>
      </Drawer>

      {/* Delete confirm — removing a rule stops the paging for every device
          only it watched, so the row's Delete button opens this instead of
          deleting outright. */}
      <Drawer
        open={ruleDelete !== null}
        onOpenChange={(open) => {
          if (!open) setRuleDelete(null);
        }}
        title="Delete device-down rule"
        description={ruleDelete ? ruleSummary(ruleDelete) : undefined}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <span style={{ fontSize: 13, color: 'var(--nd-text-secondary)', lineHeight: 1.6 }}>
            The rule is removed immediately and the deletion is audit-logged. A device only this rule watched
            will page no one when it stops reporting.
          </span>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => setRuleDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" disabled={rDeleteBusy} onClick={() => void confirmDeleteRule()}>
              {rDeleteBusy ? 'Deleting…' : 'Delete rule'}
            </Button>
          </div>
        </div>
      </Drawer>

      {/* Occurrence timeline — one group's history joined from the queue, the
          silence store, the device change log and config-backup drift. Times
          marked ≈ derive from the queue's age strings, not a clock reading. */}
      <Drawer
        open={timelineGroup !== null}
        onOpenChange={(open) => {
          if (!open) setTimelineGroup(null);
        }}
        title="Occurrence timeline"
        description={
          timelineGroup
            ? `${timelineGroup.latest.title} · ${timelineGroup.latest.plane}${
                timelineGroup.latest.device && timelineGroup.latest.device !== '—' ? ` · ${timelineGroup.latest.device}` : ''
              }`
            : undefined
        }
      >
        {timelineLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
            <Spinner size="md" />
          </div>
        ) : timeline ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {timelineNote ? (
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: 'var(--nd-text-muted)',
                  paddingBottom: 8,
                }}
              >
                {timelineNote}
              </span>
            ) : null}
            {timeline.correlation ? (
              <div style={{ paddingBottom: 10 }}>
                <Alert tone="info" title="Correlation in time — not a proven cause">
                  <span style={{ fontSize: 13 }}>{timeline.correlation}</span>
                </Alert>
              </div>
            ) : null}
            {timeline.events.map((e, i) => (
              <div
                key={`${e.ts}-${i}`}
                style={{
                  display: 'flex',
                  gap: 12,
                  padding: '8px 0',
                  borderBottom: i < timeline.events.length - 1 ? '1px solid var(--nd-border-default)' : undefined,
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-text-muted)',
                    width: 76,
                    flexShrink: 0,
                    paddingTop: 2,
                  }}
                >
                  {`${untilLabel(e.ts)}${e.approximate ? ' ≈' : ''}`}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Badge tone={timelineTone(e.kind)} dot>
                      {timelineKindLabel(e.kind)}
                    </Badge>
                    <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>{e.label}</span>
                  </span>
                  {e.detail ? (
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-11)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {e.detail}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No timeline available"
            description={timelineNote ?? 'Nothing is on record for this group — no silences, no changes, no drift.'}
          />
        )}
      </Drawer>
    </div>
  );
}
