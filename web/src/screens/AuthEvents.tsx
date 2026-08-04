/**
 * web/src/screens/AuthEvents.tsx — every RADIUS decision.
 * High-fidelity port of design/NtAuthEvents.dc.html: 5-Stat row, local AND
 * filter row (search / result / service / plane) with the right-aligned mono
 * count, the 8-column open table (endpoint MAC deep-links to /clients?mac=,
 * NAS device to /devices/:name), then a flair divider and two columns:
 * "Why authentications failed" (Progress bars, max=60) and "Policy services".
 * The search field honours ?q=<text> so the client drawer's "Auth history"
 * action lands pre-filtered.
 * The filter row also carries a TimeRangeControl (15m–7d / All) kept in the
 * URL as ?range= so a narrowed view is shareable. Filter-row state writes
 * back `q` / `result` / `service` / `method` / `role` / `plane` (with `range`) so
 * **Copy view link** shares the same slice a refresh would reopen —
 * Sites/Devices pattern. Server list paging (`limit`/`cursor`) also receives
 * `q`/`plane`/`result`/`service`/`method`/`role`/`range` so Load more continues the
 * filtered feed rather than appending an unfiltered page. The range can only
 * narrow what the feed already
 * holds — a live feed is the current poller snapshot, minutes of traffic rather
 * than days — so when the picked range reaches further back than the snapshot
 * does, the row says so (the same voice the breakdown's CURRENT POLLER SNAPSHOT
 * caveat uses), and rows that carry no timestamp stay shown under any range
 * (server + client), counted in the same caveat. Download server CSV sends the
 * same range so the file matches the filter bar.
 * Active filters surface as removable chips (plus Clear all); a **Result** chip
 * row (counts over q+service+method+role+plane+range) toggles the same
 * `result` filter as the header Select — click again to clear. A **Method** chip
 * row (counts over q+result+service+role+plane+range — Loop 143) toggles the same
 * `method` filter. A **Service** chip row (counts over q+result+method+role+plane+range —
 * Loop 148) toggles the same `service` filter. A **Role** chip row (counts over
 * q+result+service+method+plane+range — Loop 149) toggles the same `role` filter.
 * A **Plane** chip row (counts over q+result+service+method+role+range — Loop 152)
 * toggles the same `plane` filter. A **Range** chip row (counts over
 * q+result+service+method+role+plane — Loop 156) toggles the same `?range=` as
 * the TimeRangeControl — click again to clear back to All.
 * A filtered empty state offers Clear filters. Selection-empty `?macs=` offers
 *  **Clear selection filter** (Loop 219). The table is a keyboard grid (`x` selects;
 *  bulk **Export selected**, **Copy selection link** (`?macs=` of unique endpoint
 *  MACs — Devices `?names=` pattern; clearable chip while active), **Copy MACs**,
 *  and **Copy names** (unique newline-joined `who` identities when MACs are sparse —
 *  Clients / Sites pattern; Loop 228));
 *  fail-reasons and policy-services each offer **Export CSV**. Header **LIVE** stamps
 *  pure live and blend feeds alike.
 * Data: getAuthEvents() — live /api/auth-events when the server is up, fixtures otherwise.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  PageSkeleton,
  Badge,
  Button,
  DATATABLE_ROW_SHORTCUTS,
  Divider,
  EmptyState,
  Input,
  KeyboardShortcuts,
  Progress,
  SectionHeader,
  Select,
  DataTable,
  TableViewOptions,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { getAuthEvents } from '../api/client';
import type { AuthEventsData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { deviceDetailPath, namesFilterForParam, planeFilterForParam } from '../app/nav';
import { hhmmLocal as hhmm, hhmmssLocal } from '@hpe/shared';
import type { AuthEventRow } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import {
  TIME_RANGE_MS,
  TIME_RANGE_OPTIONS,
  TimeRangeControl,
  timeRangeForParam,
  withinTimeRange,
} from '../components/TimeRangeControl';
import type { TimeRange } from '../components/TimeRangeControl';

const AUTH_EVENT_PAGE = 250;

const RESULT_OPTIONS = [
  { value: 'all', label: 'All results' },
  { value: 'accept', label: 'Accepted' },
  { value: 'reject', label: 'Rejected' },
  { value: 'timeout', label: 'Timed out' },
];

const RESULT_CHIP_META: Array<{
  key: 'accept' | 'reject' | 'timeout';
  label: string;
  tone: 'success' | 'danger' | 'warning';
}> = [
  { key: 'accept', label: 'Accepted', tone: 'success' },
  { key: 'reject', label: 'Rejected', tone: 'danger' },
  { key: 'timeout', label: 'Timed out', tone: 'warning' },
];

const RESULT_VALUES = new Set(RESULT_OPTIONS.map((o) => o.value));

function resultFilterForParam(raw: string | null): string {
  const v = raw?.trim().toLowerCase() ?? '';
  return RESULT_VALUES.has(v) ? v : 'all';
}

function uniq<K extends keyof AuthEventRow>(events: AuthEventRow[], k: K): string[] {
  return events.map((e) => String(e[k])).filter((v, i, a) => a.indexOf(v) === i);
}

export default function AuthEvents() {
  const navigate = useNavigate();
  const { density, showPlatformTags, pollIntervalSec, tableColumns, setTableColumns } = useSettings();

  const authEventColumns: Array<DataTableColumn<AuthEventRow>> = [
    {
      key: 'time',
      title: 'Time',
      hideable: false,
      render: (e) => (
        <span className="nt-hint-muted">{e.at ? hhmmssLocal(e.at) : e.time}</span>
      ),
    },
    {
      key: 'endpoint',
      title: 'Endpoint',
      hideable: false,
      render: (e) => (
        <button
          type="button"
          onClick={() => navigate(`/clients?mac=${encodeURIComponent(e.mac)}`)}
          className="nt-btn-plain-primary"
        >
          <span className="nt-fs-12-pri">{e.who}</span>
          <span className="nt-hint-muted">{e.mac}</span>
        </button>
      ),
    },
    {
      key: 'service',
      title: 'Service',
      render: (e) => e.service,
    },
    {
      key: 'method',
      title: 'Method',
      render: (e) => <span className="nt-mono-11 nt-text-sec">{e.method}</span>,
    },
    {
      key: 'result',
      title: 'Result',
      render: (e) => (
        <Badge tone={e.tone} dot>
          {e.result}
        </Badge>
      ),
    },
    {
      key: 'reason',
      title: 'Reason / role',
      render: (e) => (
        <div className="nt-stack nt-gap-2">
          <span className="nt-fs-12-sec">{e.reason}</span>
          <span className="nt-hint-muted">{e.role}</span>
        </div>
      ),
    },
    {
      key: 'nas',
      title: 'NAS device',
      render: (e) => (
        <button
          type="button"
          onClick={() => navigate(deviceDetailPath({ name: e.nas, plane: e.plane }))}
          className="nt-mono-link nt-ta-left"
        >
          {e.nas}
        </button>
      ),
    },
    {
      key: 'plane',
      title: 'Plane',
      render: (e) => (showPlatformTags ? <Badge plane>{e.plane}</Badge> : null),
    },
  ];

  const { toast } = useToast();
  const [data, setData] = useState<AuthEventsData | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [result, setResult] = useState(() => resultFilterForParam(searchParams.get('result')));
  const [service, setService] = useState(() => {
    const s = searchParams.get('service')?.trim();
    return s && s.length > 0 ? s : 'all';
  });
  const [method, setMethod] = useState(() => {
    const m = searchParams.get('method')?.trim();
    return m && m.length > 0 ? m : 'all';
  });
  const [role, setRole] = useState(() => {
    const r = searchParams.get('role')?.trim();
    return r && r.length > 0 ? r : 'all';
  });
  const [plane, setPlane] = useState(() => planeFilterForParam(searchParams.get('plane')));
  /* The time range lives in the URL (?range=) rather than in state — the same
     rule Devices gives ?names=: a filter that narrows the log this hard must
     not drift from the address that explains it, and the view stays shareable.
     Read straight off the params; 'all' is the absent param, never written. */
  const timeRange = timeRangeForParam(searchParams.get('range'));
  const setTimeRange = (range: TimeRange) => {
    const next = new URLSearchParams(searchParams);
    if (range === 'all') next.delete('range');
    else next.set('range', range);
    setSearchParams(next, { replace: true });
  };
  /* Deep link: /auth-events?macs=aa\nbb (bulk Copy selection link). Same
   * read-off-the-URL rule as Devices ?names= / Alerts ?fps=. */
  const macsFilter = namesFilterForParam(searchParams.get('macs'));
  /* The range cutoff is measured against now, held in state so an arbitrary
     re-render cannot move it: a row sitting exactly on the cutoff must not
     flicker between the table and the caveats as other filters change. It
     advances only when a poll lands fresh rows — the cutoff and the feed then
     describe the same moment. (A bare Date.now() in render trips the
     compiler's purity rule; a hook this late would trip rules-of-hooks, so it
     lives with the other hooks.) */
  const [nowMs, setNowMs] = useState(() => Date.now());

  /* Keep ?q= / ?result= / ?service= / ?method= / ?role= / ?plane= aligned with the
     filter row so a refresh or shared URL opens the same slice. range is
     owned by TimeRangeControl. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const qTrim = q.trim();
    if (qTrim) next.set('q', qTrim);
    else next.delete('q');
    if (result !== 'all') next.set('result', result);
    else next.delete('result');
    if (service !== 'all') next.set('service', service);
    else next.delete('service');
    if (method !== 'all') next.set('method', method);
    else next.delete('method');
    if (role !== 'all') next.set('role', role);
    else next.delete('role');
    if (plane !== 'all') next.set('plane', plane);
    else next.delete('plane');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [q, result, service, method, role, plane, searchParams, setSearchParams]);

  /* A NOC tab must not sit on a mount-time snapshot under a SYNCED stamp:
     poll on the settings cadence, the same pattern Overview.tsx runs. One
     fetch at a time; fixture reads poll harmlessly. Live lists page at 250
     events so large ClearPass feeds can Load more. Server q/plane/result/
     service/method ride the request so append continues the same filtered feed. */
  const eventsAccRef = useRef<AuthEventRow[]>([]);
  const nextEventCursorRef = useRef<string | null>(null);
  const loadMoreEventsRef = useRef<() => void>(() => {});
  const [eventHasMore, setEventHasMore] = useState(false);
  const [eventPageTotal, setEventPageTotal] = useState<number | null>(null);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const serverQ = q.trim();
  const serverPlane = plane !== 'all' ? plane : undefined;
  const serverResult = result !== 'all' ? result : undefined;
  const serverService = service !== 'all' ? service : undefined;
  const serverMethod = method !== 'all' ? method : undefined;
  const serverRole = role !== 'all' ? role : undefined;
  const serverRange = timeRange !== 'all' ? timeRange : undefined;

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = (mode: 'replace' | 'append' = 'replace') => {
      if (mode === 'replace' && inFlight) return;
      if (mode === 'append' && !nextEventCursorRef.current) return;
      if (mode === 'replace') inFlight = true;
      if (mode === 'append') setLoadingMoreEvents(true);
      void getAuthEvents({
        limit: AUTH_EVENT_PAGE,
        ...(serverQ ? { q: serverQ } : {}),
        ...(serverPlane ? { plane: serverPlane } : {}),
        ...(serverResult ? { result: serverResult } : {}),
        ...(serverService ? { service: serverService } : {}),
        ...(serverMethod ? { method: serverMethod } : {}),
        ...(serverRole ? { role: serverRole } : {}),
        ...(serverRange ? { range: serverRange } : {}),
        ...(mode === 'append' && nextEventCursorRef.current
          ? { cursor: nextEventCursorRef.current }
          : {}),
      })
        .then((d) => {
          if (!live) return;
          if (mode === 'append') {
            const keyOf = (e: AuthEventRow) =>
              `${e.at ?? ''}|${e.mac}|${e.who}|${e.result}|${e.nas}|${e.time}`;
            const seen = new Set(eventsAccRef.current.map(keyOf));
            const extra = d.events.filter((e) => !seen.has(keyOf(e)));
            const merged = [...eventsAccRef.current, ...extra];
            eventsAccRef.current = merged;
            setData({ ...d, events: merged });
          } else {
            eventsAccRef.current = d.events;
            setData(d);
          }
          nextEventCursorRef.current = d.page?.nextCursor ?? null;
          setEventHasMore(Boolean(d.page?.nextCursor));
          setEventPageTotal(d.page?.total ?? null);
          setNowMs(Date.now());
        })
        .finally(() => {
          if (mode === 'replace') inFlight = false;
          if (mode === 'append') setLoadingMoreEvents(false);
        });
    };
    loadMoreEventsRef.current = () => pull('append');
    /* Server filters changed — drop the accumulated page and start over. */
    nextEventCursorRef.current = null;
    eventsAccRef.current = [];
    pull('replace');
    const every = Math.max(pollIntervalSec, 10) * 1000;
    const id = setInterval(() => pull('replace'), every);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pollIntervalSec, serverQ, serverPlane, serverResult, serverService, serverMethod, serverRole, serverRange]);

  /* Deep links: ?q=<mac> (client drawer's Auth history), ?plane=<registryId>
     (Systems plane drawer), ?result= / ?service= / ?method= / ?role= share links.
     Applied when the URL changes while the screen is mounted — state adjusted
     during render. */
  const [prevParams, setPrevParams] = useState(searchParams);
  if (prevParams !== searchParams) {
    setPrevParams(searchParams);
    const qp = searchParams.get('q');
    if (qp !== null) setQ(qp);
    const pp = searchParams.get('plane');
    if (pp !== null) setPlane(planeFilterForParam(pp));
    const rp = searchParams.get('result');
    if (rp !== null) setResult(resultFilterForParam(rp));
    const sp = searchParams.get('service');
    if (sp !== null) setService(sp.trim() || 'all');
    const mp = searchParams.get('method');
    if (mp !== null) setMethod(mp.trim() || 'all');
    const roleP = searchParams.get('role');
    if (roleP !== null) setRole(roleP.trim() || 'all');
  }

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const events = data.events;
  const ql = q.trim().toLowerCase();
  const matchesAuthQ = (e: AuthEventRow) =>
    !ql || (e.who + e.mac + e.reason + e.nas + e.role + e.method).toLowerCase().includes(ql);
  const matchesAuthRange = (e: AuthEventRow) => withinTimeRange(e.at, timeRange, nowMs);
  const matchesAuthQRange = (e: AuthEventRow) => matchesAuthQ(e) && matchesAuthRange(e);
  const matchesPlane = (e: AuthEventRow) => plane === 'all' || e.plane === plane;
  const matchesAuthBase = (e: AuthEventRow) => matchesAuthQRange(e) && matchesPlane(e);
  const matchesRole = (e: AuthEventRow) => role === 'all' || e.role === role;
  const matchesService = (e: AuthEventRow) => service === 'all' || e.service === service;
  const matchesResult = (e: AuthEventRow) => result === 'all' || e.result === result;
  const matchesMethod = (e: AuthEventRow) => method === 'all' || e.method === method;
  const macsFilterLc =
    macsFilter === null ? null : macsFilter.map((m) => m.trim().toLowerCase()).filter(Boolean);
  const matchesMacs = (e: AuthEventRow) =>
    macsFilterLc === null || macsFilterLc.includes((e.mac ?? '').trim().toLowerCase());
  /* Result / method / service / role / plane / range chips each count over every
   * filter except their own — mix stays visible while a chip is on
   * (Loops 143/148/149/152/156). macs= narrows every universe (selection share). */
  const resultUniverse = events.filter(
    (e) =>
      matchesAuthBase(e) && matchesRole(e) && matchesService(e) && matchesMethod(e) && matchesMacs(e),
  );
  const methodUniverse = events.filter(
    (e) =>
      matchesAuthBase(e) && matchesRole(e) && matchesService(e) && matchesResult(e) && matchesMacs(e),
  );
  const serviceUniverse = events.filter(
    (e) =>
      matchesAuthBase(e) && matchesRole(e) && matchesMethod(e) && matchesResult(e) && matchesMacs(e),
  );
  const roleUniverse = events.filter(
    (e) =>
      matchesAuthBase(e) &&
      matchesService(e) &&
      matchesMethod(e) &&
      matchesResult(e) &&
      matchesMacs(e),
  );
  const planeUniverse = events.filter(
    (e) =>
      matchesAuthQRange(e) &&
      matchesRole(e) &&
      matchesService(e) &&
      matchesMethod(e) &&
      matchesResult(e) &&
      matchesMacs(e),
  );
  const rangeUniverse = events.filter(
    (e) =>
      matchesAuthQ(e) &&
      matchesPlane(e) &&
      matchesRole(e) &&
      matchesService(e) &&
      matchesMethod(e) &&
      matchesResult(e) &&
      matchesMacs(e),
  );
  const rows = events.filter(
    (e) =>
      matchesAuthBase(e) &&
      matchesRole(e) &&
      matchesService(e) &&
      matchesMethod(e) &&
      matchesResult(e) &&
      matchesMacs(e),
  );
  const macsPresent =
    macsFilter === null
      ? 0
      : macsFilter.filter((m) =>
          events.some((e) => (e.mac ?? '').trim().toLowerCase() === m.trim().toLowerCase()),
        ).length;
  const resultChips = RESULT_CHIP_META.map((m) => ({
    ...m,
    count: resultUniverse.filter((e) => e.result === m.key).length,
  })).filter((c) => c.count > 0 || result === c.key);
  const methodChipKeys = [
    ...new Set(methodUniverse.map((e) => String(e.method ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (method !== 'all' && !methodChipKeys.includes(method)) methodChipKeys.unshift(method);
  const methodChips = methodChipKeys.map((key) => ({
    key,
    label: key,
    count: methodUniverse.filter((e) => e.method === key).length,
  })).filter((c) => c.count > 0 || method === c.key);
  const serviceChipKeys = [
    ...new Set(serviceUniverse.map((e) => String(e.service ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (service !== 'all' && !serviceChipKeys.includes(service)) serviceChipKeys.unshift(service);
  const serviceChips = serviceChipKeys
    .map((key) => ({
      key,
      label: key,
      count: serviceUniverse.filter((e) => e.service === key).length,
    }))
    .filter((c) => c.count > 0 || service === c.key);
  const roleChipKeys = [
    ...new Set(roleUniverse.map((e) => String(e.role ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (role !== 'all' && !roleChipKeys.includes(role)) roleChipKeys.unshift(role);
  const roleChips = roleChipKeys
    .map((key) => ({
      key,
      label: key,
      count: roleUniverse.filter((e) => e.role === key).length,
    }))
    .filter((c) => c.count > 0 || role === c.key);
  const planeChipKeys = [
    ...new Set(planeUniverse.map((e) => String(e.plane ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (plane !== 'all' && !planeChipKeys.includes(plane)) planeChipKeys.unshift(plane);
  const planeChips = planeChipKeys
    .map((key) => ({
      key,
      label: key,
      count: planeUniverse.filter((e) => e.plane === key).length,
    }))
    .filter((c) => c.count > 0 || plane === c.key);
  /* Range chips count over q+result+service+method+role+plane (not range) and
   * toggle the same `?range=` the TimeRangeControl writes (Loop 156). */
  const rangeChips = TIME_RANGE_OPTIONS.filter((o) => o.value !== 'all')
    .map((o) => ({
      key: o.value as Exclude<TimeRange, 'all'>,
      label: o.label,
      count: rangeUniverse.filter((e) => withinTimeRange(e.at, o.value, nowMs)).length,
    }))
    .filter((c) => c.count > 0 || timeRange === c.key);

  const serviceOptions = [{ value: 'all', label: 'All services' }].concat(
    uniq(events, 'service').map((v) => ({ value: v, label: v })),
  );
  const methodOptions = [{ value: 'all', label: 'All methods' }].concat(
    uniq(events, 'method').map((v) => ({ value: v, label: v })),
  );
  const roleOptions = [{ value: 'all', label: 'All roles' }].concat(
    uniq(events, 'role').map((v) => ({ value: v, label: v })),
  );
  const planeOptions = [{ value: 'all', label: 'All planes' }].concat(
    uniq(events, 'plane').map((v) => ({ value: v, label: v })),
  );
  /* A ?plane= / ?service= / ?method= / ?role= deep-link can name a value that has no
     rows in this feed (or page). Without its own option the Select renders
     blank and the filter hiding every row is invisible and unclearable —
     union active values. */
  if (plane !== 'all' && !planeOptions.some((o) => o.value === plane)) {
    planeOptions.push({ value: plane, label: `${plane} (no events)` });
  }
  if (service !== 'all' && !serviceOptions.some((o) => o.value === service)) {
    serviceOptions.push({ value: service, label: `${service} (no events)` });
  }
  if (method !== 'all' && !methodOptions.some((o) => o.value === method)) {
    methodOptions.push({ value: method, label: `${method} (no events)` });
  }
  if (role !== 'all' && !roleOptions.some((o) => o.value === role)) {
    roleOptions.push({ value: role, label: `${role} (no events)` });
  }

  /* This screen is fed by one plane (ClearPass), and the poller keeps serving a
   * degraded plane's last-good rows — so the header has to say when they were
   * pulled, and whether they are fixtures at all (README design rule 1). */
  const sectionLive = data.dataSource === 'live' || (data.blended?.includes('authEvents') ?? false);
  const synced = sectionLive ? `SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : '—'}` : 'SYNCED 09:41';
  const filtersActive =
    Boolean(q.trim()) ||
    result !== 'all' ||
    service !== 'all' ||
    method !== 'all' ||
    role !== 'all' ||
    plane !== 'all' ||
    timeRange !== 'all' ||
    macsFilter !== null;
  const clearAuthFilters = () => {
    setQ('');
    setResult('all');
    setService('all');
    setMethod('all');
    setRole('all');
    setPlane('all');
    setTimeRange('all');
    if (macsFilter) {
      const next = new URLSearchParams(searchParams);
      next.delete('macs');
      setSearchParams(next, { replace: true });
    }
  };

  /* What the active range must say for itself, in the filter row:
   *  - a live feed is the current poller snapshot (minutes of traffic, not a
   *    day — the breakdown below says the same). When the picked range
   *    reaches further back than even the feed's oldest row, the filter is
   *    not "showing 24h", it is narrowing a shorter window, and the row has
   *    to say so rather than let the range label overclaim.
   *  - a row with no `at` cannot be placed in any window, so it stays shown
   *    under every range — and is counted, so its presence under a narrowed
   *    view is explained rather than mistaken for a filter that did nothing.
   * Both are measured over the whole feed, not the filtered rows: they
   * describe what the range CAN see here, not what the other filters left. */
  const cutoffMs = timeRange === 'all' ? null : nowMs - TIME_RANGE_MS[timeRange];
  const rangeCaveats: string[] = [];
  if (cutoffMs !== null) {
    const datedMs = events
      .map((e) => (e.at ? new Date(e.at).getTime() : Number.NaN))
      .filter((ms) => Number.isFinite(ms));
    if (sectionLive && datedMs.length > 0 && Math.min(...datedMs) > cutoffMs) {
      rangeCaveats.push(
        `The feed is the current poller snapshot — a ${timeRange} range reaches further back than the snapshot holds.`,
      );
    }
    const undated = events.length - datedMs.length;
    if (undated > 0) {
      rangeCaveats.push(
        undated === 1
          ? '1 row carries no timestamp and stays shown whatever the range.'
          : `${undated} rows carry no timestamp and stay shown whatever the range.`,
      );
    }
  }

  return (
    <div className="nt-stack nt-recon-reveal nt-auth-events-shell nt-section-panel">
      <ScreenHeader
        overline="Operate / Auth events"
        title="Auth & policy events"
        subtitle="Every RADIUS decision, whichever plane asked the question."
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              HPE Network Tools · identity
            </span>
            <Badge plane>ClearPass</Badge>
            <span className="nt-mono-label">
              {synced}
            </span>
            {/* LIVE when the feed is live or blend-swapped — pure live used to omit the badge. */}
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <Button variant="ghost" size="sm" onClick={() => navigate('/clients')}>
              Clients →
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  /* Build from filter state (write-back keeps the bar in sync;
                     MemoryRouter tests and some embeds do not share window.location). */
                  const next = new URLSearchParams();
                  if (q.trim()) next.set('q', q.trim());
                  if (result !== 'all') next.set('result', result);
                  if (service !== 'all') next.set('service', service);
                  if (method !== 'all') next.set('method', method);
                  if (role !== 'all') next.set('role', role);
                  if (plane !== 'all') next.set('plane', plane);
                  if (timeRange !== 'all') next.set('range', timeRange);
                  if (macsFilter) next.set('macs', macsFilter.join('\n'));
                  const qs = next.toString();
                  const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('View link copied', { description: qs || 'unfiltered auth events', tone: 'success' });
                  } catch {
                    toast('Could not copy link', { description: url, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy view link
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const n = exportTableCsv(
                  'auth-events.csv',
                  ['time', 'at', 'who', 'mac', 'result', 'service', 'method', 'role', 'reason', 'nas', 'plane'],
                  rows.map((e) => [
                    e.time,
                    e.at ?? '',
                    e.who,
                    e.mac,
                    e.result,
                    e.service,
                    e.method,
                    e.role,
                    e.reason,
                    e.nas,
                    e.plane,
                  ]),
                );
                toast(`Exported ${n} event${n === 1 ? '' : 's'}`, {
                  description: 'auth-events.csv — rows currently in view.',
                });
              }}
            >
              Export CSV
            </Button>
            {data.dataSource === 'live' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const qs = new URLSearchParams();
                    if (q.trim()) qs.set('q', q.trim());
                    if (plane !== 'all') qs.set('plane', plane);
                    if (result !== 'all') qs.set('result', result);
                    if (service !== 'all') qs.set('service', service);
                    if (method !== 'all') qs.set('method', method);
                    if (role !== 'all') qs.set('role', role);
                    if (timeRange !== 'all') qs.set('range', timeRange);
                    const suffix = qs.toString() ? `?${qs}` : '';
                    const res = await downloadApiCsv(
                      `/api/auth-events/export${suffix}`,
                      'auth-events.csv',
                    );
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description: 'auth-events.csv — portal auth-events export.',
                        tone: 'success',
                      });
                    } else {
                      toast('Server CSV failed', {
                        description: res.error ?? 'Could not download export',
                        tone: 'warning',
                      });
                    }
                  })();
                }}
              >
                Download server CSV
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                toast('Live tail needs the streaming events backend — not in this build')
              }
            >
              Live tail
            </Button>
          </>
}
      />

      <div className="nt-plane-theater" role="note">HPE Network Tools · identity theater · auth outcome owns hue</div>
      <div className="nt-status-ribbon nt-auth-ribbon" role="status" aria-label="Auth events status ribbon">
        <span className="nt-status-ribbon__item">identity · outcome owns hue</span>
        <span className="nt-status-ribbon__item">RADIUS · CoA path</span>
        <span className="nt-status-ribbon__item">planes monochrome</span>
      </div>

      <StatRow stats={data.stats} />

      {resultChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Auth result">
          <span className="nt-chip-row__label">Result</span>
          {resultChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setResult(result === c.key ? 'all' : c.key)}
              className={result === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={result === c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {methodChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Auth method">
          <span className="nt-chip-row__label">Method</span>
          {methodChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setMethod(method === c.key ? 'all' : c.key)}
              className={method === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={method === c.key}
              data-method={c.key}
            >
              <Badge tone="neutral">{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {serviceChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Auth service">
          <span className="nt-chip-row__label">Service</span>
          {serviceChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setService(service === c.key ? 'all' : c.key)}
              className={
                service === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={service === c.key}
              data-service={c.key}
            >
              <Badge tone="info">{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {roleChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Auth role">
          <span className="nt-chip-row__label">Role</span>
          {roleChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setRole(role === c.key ? 'all' : c.key)}
              className={
                role === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={role === c.key}
              data-role={c.key}
            >
              <Badge tone="neutral">{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {planeChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Auth plane">
          <span className="nt-chip-row__label">Plane</span>
          {planeChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setPlane(plane === c.key ? 'all' : c.key)}
              className={
                plane === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={plane === c.key}
              data-plane={c.key}
            >
              <Badge plane>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {rangeChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Auth time range">
          <span className="nt-chip-row__label">Range</span>
          {rangeChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setTimeRange(timeRange === c.key ? 'all' : c.key)}
              className={
                timeRange === c.key
                  ? 'nt-chip nt-chip--active nt-toggle-chip'
                  : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={timeRange === c.key}
              data-range={c.key}
            >
              <Badge tone="neutral">{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="nt-filter-bar nt-sticky-filters">
        <div className="nt-filter-field nt-filter-field--xl nt-w-250">
          <Input
            size="sm"
            mono
            placeholder="user, MAC, reason, NAS…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter auth events"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--sm">
          <Select
            options={RESULT_OPTIONS}
            value={result}
            onValueChange={setResult}
            size="sm"
            aria-label="Result"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--lg nt-w-200">
          <Select
            options={serviceOptions}
            value={service}
            onValueChange={setService}
            size="sm"
            aria-label="Service"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--md">
          <Select
            options={methodOptions}
            value={method}
            onValueChange={setMethod}
            size="sm"
            aria-label="Method"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--lg nt-w-200">
          <Select
            options={roleOptions}
            value={role}
            onValueChange={setRole}
            size="sm"
            aria-label="Role"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--md">
          <Select
            options={planeOptions}
            value={plane}
            onValueChange={setPlane}
            size="sm"
            aria-label="Plane"
          />
        </div>
        <TimeRangeControl value={timeRange} onValueChange={setTimeRange} />
        <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
        <span className="nt-filter-bar__count">
          {/* The daily-indexed tail is a fixture total the API never returns —
              a live/blended feed shows only what it actually holds. */}
          {rows.length} of {events.length} shown
          {eventPageTotal != null && eventPageTotal > events.length
            ? ` · ${eventPageTotal} in feed`
            : ''}
          {sectionLive ? '' : ' · 1,904 events indexed today'}
        </span>
        {rangeCaveats.length > 0 ? (
          <span
            className="nt-service-note nt-basis-100"
          >
            {rangeCaveats.join(' ')}
          </span>
        ) : null}
      </div>

      {filtersActive ? (
        <div className="nt-filter-chips" role="group" aria-label="Active auth filters">
          {q.trim() ? (
            <span className="nt-filter-chip">
              q: {q.trim()}
              <button type="button" aria-label="Clear text filter" onClick={() => setQ('')}>
                ×
              </button>
            </span>
          ) : null}
          {result !== 'all' ? (
            <span className="nt-filter-chip">
              result: {result}
              <button type="button" aria-label="Clear result filter" onClick={() => setResult('all')}>
                ×
              </button>
            </span>
          ) : null}
          {service !== 'all' ? (
            <span className="nt-filter-chip">
              service: {service}
              <button type="button" aria-label="Clear service filter" onClick={() => setService('all')}>
                ×
              </button>
            </span>
          ) : null}
          {method !== 'all' ? (
            <span className="nt-filter-chip">
              method: {method}
              <button type="button" aria-label="Clear method filter" onClick={() => setMethod('all')}>
                ×
              </button>
            </span>
          ) : null}
          {role !== 'all' ? (
            <span className="nt-filter-chip">
              role: {role}
              <button type="button" aria-label="Clear role filter" onClick={() => setRole('all')}>
                ×
              </button>
            </span>
          ) : null}
          {plane !== 'all' ? (
            <span className="nt-filter-chip">
              plane: {plane}
              <button type="button" aria-label="Clear plane filter" onClick={() => setPlane('all')}>
                ×
              </button>
            </span>
          ) : null}
          {timeRange !== 'all' ? (
            <span className="nt-filter-chip">
              range: {timeRange}
              <button type="button" aria-label="Clear time range" onClick={() => setTimeRange('all')}>
                ×
              </button>
            </span>
          ) : null}
          {macsFilter !== null ? (
            <span className="nt-filter-chip" title={macsFilter.join(', ')}>
              {macsPresent === macsFilter.length
                ? `${macsFilter.length} selected MAC${macsFilter.length === 1 ? '' : 's'}`
                : `${macsPresent} of ${macsFilter.length} selected MACs — ${macsFilter.length - macsPresent} not in this feed`}
              <button
                type="button"
                aria-label="Clear MAC selection filter"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('macs');
                  setSearchParams(next, { replace: true });
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          <button type="button" className="nt-filter-clear" onClick={clearAuthFilters}>
            Clear all
          </button>
        </div>
      ) : null}

      <div className="nt-stack nt-gap-8">
        <div className="nt-row-between">
          <span className="nd-micro-label nt-micro-label">Auth feed</span>
          <TableViewOptions
            columns={authEventColumns}
            config={tableColumns.authEvents ?? {}}
            onChange={(config) => setTableColumns('authEvents', config)}
          />
        </div>
        <DataTable
          ariaLabel="Authentication events"
          density={density}
          columns={authEventColumns}
          rows={rows}
          rowKey={(e, i) => `${e.time}|${e.mac}|${e.nas}|${i}`}
          columnsConfig={tableColumns.authEvents}
          onColumnsConfigChange={(config) => setTableColumns('authEvents', config)}
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
          rowTone={(e) => e.tone}
        />
        {selectedKeys.length > 0 ? (
          <div className="nt-configure-bulk-bar nt-bulk-glass" role="region" aria-label="Auth event selection actions">
            <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
            <span className="nt-configure-bulk-bar__hint">
              export, share, copy MACs, or copy names for the decisions you marked — full log export stays in the header
            </span>
            <span className="nt-configure-bulk-bar__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const selected = new Set(selectedKeys);
                  const picked = rows.filter((e, i) =>
                    selected.has(`${e.time}|${e.mac}|${e.nas}|${i}`),
                  );
                  if (picked.length === 0) {
                    toast('No selected events still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const n = exportTableCsv(
                    'auth-events-selected.csv',
                    ['time', 'at', 'who', 'mac', 'result', 'service', 'method', 'role', 'reason', 'nas', 'plane'],
                    picked.map((e) => [
                      e.time,
                      e.at ?? '',
                      e.who,
                      e.mac,
                      e.result,
                      e.service,
                      e.method,
                      e.role,
                      e.reason,
                      e.nas,
                      e.plane,
                    ]),
                  );
                  toast(`Exported ${n} selected event${n === 1 ? '' : 's'}`, {
                    description: 'auth-events-selected.csv — decision fields only.',
                    tone: 'success',
                  });
                }}
              >
                Export selected
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((e, i) =>
                      selected.has(`${e.time}|${e.mac}|${e.nas}|${i}`),
                    );
                    if (picked.length === 0) {
                      toast('No selected events still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const macs = [
                      ...new Set(
                        picked
                          .map((e) => (e.mac ?? '').trim())
                          .filter(Boolean),
                      ),
                    ];
                    if (macs.length === 0) {
                      toast('No MACs on the selected events', {
                        description: 'Those rows did not publish a MAC — export CSV for identities instead.',
                        tone: 'info',
                      });
                      return;
                    }
                    const next = new URLSearchParams(searchParams);
                    next.set('macs', macs.join('\n'));
                    const qs = next.toString();
                    const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                    try {
                      await navigator.clipboard.writeText(url);
                      toast('Selection link copied', {
                        description: `${macs.length} MAC${macs.length === 1 ? '' : 's'} · macs=`,
                        tone: 'success',
                      });
                    } catch {
                      toast('Could not copy link', { description: url, tone: 'warning' });
                    }
                  })();
                }}
              >
                Copy selection link
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((e, i) =>
                      selected.has(`${e.time}|${e.mac}|${e.nas}|${i}`),
                    );
                    if (picked.length === 0) {
                      toast('No selected events still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const macs = [
                      ...new Set(
                        picked
                          .map((e) => (e.mac ?? '').trim())
                          .filter(Boolean),
                      ),
                    ];
                    if (macs.length === 0) {
                      toast('No MACs on the selected events', {
                        description: 'Those rows did not publish a MAC — use Copy names or export CSV instead.',
                        tone: 'info',
                      });
                      return;
                    }
                    const text = macs.join('\n');
                    try {
                      await navigator.clipboard.writeText(text);
                      toast(`Copied ${macs.length} MAC${macs.length === 1 ? '' : 's'}`, {
                        description: 'newline-joined · paste into Clients or a NAC lookup',
                        tone: 'success',
                      });
                    } catch {
                      toast('Could not copy MACs', { description: text, tone: 'warning' });
                    }
                  })();
                }}
              >
                Copy MACs
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((e, i) =>
                      selected.has(`${e.time}|${e.mac}|${e.nas}|${i}`),
                    );
                    if (picked.length === 0) {
                      toast('No selected events still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const names = [
                      ...new Set(
                        picked
                          .map((e) => (e.who ?? '').trim())
                          .filter((name) => name && name !== '—'),
                      ),
                    ];
                    if (names.length === 0) {
                      toast('No names on the selected events', {
                        description: 'Those rows did not publish a who identity — export CSV instead.',
                        tone: 'info',
                      });
                      return;
                    }
                    const text = names.join('\n');
                    try {
                      await navigator.clipboard.writeText(text);
                      toast(`Copied ${names.length} name${names.length === 1 ? '' : 's'}`, {
                        description:
                          names.length < picked.length
                            ? `${picked.length - names.length} selected without a name skipped`
                            : 'newline-joined · paste into a ticket or NAC lookup',
                        tone: 'success',
                      });
                    } catch {
                      toast('Could not copy names', { description: text, tone: 'warning' });
                    }
                  })();
                }}
              >
                Copy names
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                Clear
              </Button>
            </span>
          </div>
        ) : null}
      </div>

      {eventHasMore ? (
        <div className="nt-center-pad nt-pad-8-0">
          <Button
            variant="secondary"
            size="sm"
            disabled={loadingMoreEvents}
            onClick={() => loadMoreEventsRef.current()}
          >
            {loadingMoreEvents ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}

      {/* An empty feed is a missing policy plane, not a tight filter — telling the
          operator to loosen filters already at 'all' blames them for the gap. */}
      {rows.length === 0 ? (
        events.length === 0 ? (
          <EmptyState
            title="No auth events from any policy plane"
            description={
              sectionLive
                ? 'ClearPass has not returned decisions for this window — check Connected systems.'
                : 'No policy plane has recorded a decision in this window.'
            }
          >
            {sectionLive ? (
              <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                Connected systems
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <EmptyState
            title={
              macsFilter !== null
                ? 'No events match this selection'
                : 'Nothing matches that filter'
            }
            description={
              macsFilter !== null
                ? 'Clear the selection filter to restore the log under the current result / service / method / role / plane / range filters.'
                : timeRange === 'all'
                  ? 'Loosen the result, service or plane filter to see more of the log.'
                  : 'Loosen the result, service or plane filter — or widen the time range — to see more of the log.'
            }
          >
            {macsFilter !== null ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('macs');
                  setSearchParams(next, { replace: true });
                  setSelectedKeys([]);
                }}
              >
                Clear selection filter
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={clearAuthFilters}>
                Clear filters
              </Button>
            )}
          </EmptyState>
        )
      ) : null}

      <Divider variant="flair" />

      <div
        className="nt-auth-grid"
      >
        <div className="nt-stack nt-gap-14">
          {/* The live bars count rejects out of the poller's ≤200-event page —
              minutes of traffic, not a day. Only the fixture feed is a 24h cut. */}
          <div className="nt-row-between">
            <SectionHeader
              label="Why authentications failed"
              meta={sectionLive ? 'CURRENT POLLER SNAPSHOT' : 'LAST 24 HOURS'}
            />
            {data.failReasons.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const n = exportTableCsv(
                    'auth-fail-reasons.csv',
                    ['label', 'value', 'note'],
                    data.failReasons.map((r) => [r.label, r.value, r.note]),
                  );
                  toast(`Exported ${n} fail reason${n === 1 ? '' : 's'}`, {
                    description: 'auth-fail-reasons.csv — breakdown rows only.',
                    tone: 'success',
                  });
                }}
              >
                Export CSV
              </Button>
            ) : null}
          </div>
          {data.failReasons.length === 0 ? (
            <span
              className="nt-service-note"
            >
              {/* "No rejects" and "no feed at all" are different facts, and the
                  first one reads as a healthy network. The Stat row already
                  says '—' for an empty feed (server liveAuthStats), so the
                  breakdown must not contradict it with a clean bill of health. */}
              {events.length === 0
                ? 'No policy plane reported a decision, so there are no rejects to break down — a missing feed, not a clean one.'
                : 'No rejected authentications in this window — nothing to break down.'}
            </span>
          ) : null}
          {data.failReasons.map((r) => (
            <div key={r.label} className="nt-stack nt-gap-4">
              <Progress value={r.value} max={60} label={r.label} />
              <span
                className="nt-hint-muted"
              >
                {r.note}
              </span>
            </div>
          ))}
        </div>

        <div className="nt-stack nt-gap-2">
          <div className="nt-row-between">
            <SectionHeader label="Policy services" meta="AUTHS / HOUR" />
            {data.policyServices.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const n = exportTableCsv(
                    'auth-policy-services.csv',
                    ['name', 'detail', 'rate', 'state'],
                    data.policyServices.map((s) => [s.name, s.detail, s.rate, s.state]),
                  );
                  toast(`Exported ${n} policy service${n === 1 ? '' : 's'}`, {
                    description: 'auth-policy-services.csv — roster fields only.',
                    tone: 'success',
                  });
                }}
              >
                Export CSV
              </Button>
            ) : null}
          </div>
          {data.policyServices.length === 0 ? (
            <span
              className="nt-service-note nt-pad-10-0"
            >
              No policy service reported by a linked plane.
            </span>
          ) : null}
          {data.policyServices.map((s) => (
            <div
              key={s.name}
              className="nt-auth-row"
            >
              <div className="nt-flex-1">
                <div className="nt-fs-12-pri">
                  {s.name}
                </div>
                <div
                  className="nt-hint-muted"
                >
                  {s.detail}
                </div>
              </div>
              <span
                className="nt-mono-11 nt-w-64-right"
              >
                {s.rate}
              </span>
              <Badge tone={s.tone}>{s.state}</Badge>
            </div>
          ))}
        </div>
      </div>

      {/* Reference material and advisory panels sit below the data they
          describe. Rendered above it they pushed the primary table several
          hundred pixels down the page — on a queue screen the queue is what
          the operator came for, not the suggestions about it. */}
      <VisualReferencePanel target={{ kind: 'service', id: 'auth-events' }} />
      <ConfigRecommendationsPanel title="Auth / policy recommendations" category="security" limit={5} />
    </div>
  );
}
