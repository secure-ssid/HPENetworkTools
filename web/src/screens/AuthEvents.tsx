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
 * URL as ?range= so a narrowed view is shareable. The range can only narrow
 * what the feed already holds — a live feed is the current poller snapshot,
 * minutes of traffic rather than days — so when the picked range reaches
 * further back than the snapshot does, the row says so (the same voice the
 * breakdown's CURRENT POLLER SNAPSHOT caveat uses), and rows that carry no
 * timestamp stay shown under any range, counted in the same caveat.
 * Data: getAuthEvents() — live /api/auth-events when the server is up, fixtures otherwise.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  PageSkeleton,
  Badge,
  Button,
  Divider,
  EmptyState,
  Input,
  Progress,
  SectionHeader,
  Select, Table,
  useToast,
} from '../nightdesk';
import { getAuthEvents } from '../api/client';
import type { AuthEventsData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { deviceDetailPath, planeFilterForParam } from '../app/nav';
import { hhmmLocal as hhmm, hhmmssLocal } from '@hpe/shared';
import type { AuthEventRow } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { exportTableCsv } from '../lib/csv';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { TIME_RANGE_MS, TimeRangeControl, timeRangeForParam, withinTimeRange } from '../components/TimeRangeControl';
import type { TimeRange } from '../components/TimeRangeControl';

const AUTH_EVENT_PAGE = 250;

const RESULT_OPTIONS = [
  { value: 'all', label: 'All results' },
  { value: 'accept', label: 'Accepted' },
  { value: 'reject', label: 'Rejected' },
  { value: 'timeout', label: 'Timed out' },
];

function uniq<K extends keyof AuthEventRow>(events: AuthEventRow[], k: K): string[] {
  return events.map((e) => String(e[k])).filter((v, i, a) => a.indexOf(v) === i);
}

export default function AuthEvents() {
  const navigate = useNavigate();
  const { density, showPlatformTags, pollIntervalSec } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<AuthEventsData | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [result, setResult] = useState('all');
  const [service, setService] = useState('all');
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
  /* The range cutoff is measured against now, held in state so an arbitrary
     re-render cannot move it: a row sitting exactly on the cutoff must not
     flicker between the table and the caveats as other filters change. It
     advances only when a poll lands fresh rows — the cutoff and the feed then
     describe the same moment. (A bare Date.now() in render trips the
     compiler's purity rule; a hook this late would trip rules-of-hooks, so it
     lives with the other hooks.) */
  const [nowMs, setNowMs] = useState(() => Date.now());

  /* A NOC tab must not sit on a mount-time snapshot under a SYNCED stamp:
     poll on the settings cadence, the same pattern Overview.tsx runs. One
     fetch at a time; fixture reads poll harmlessly. Live lists page at 250
     events so large ClearPass feeds can Load more. */
  const eventsAccRef = useRef<AuthEventRow[]>([]);
  const nextEventCursorRef = useRef<string | null>(null);
  const loadMoreEventsRef = useRef<() => void>(() => {});
  const [eventHasMore, setEventHasMore] = useState(false);
  const [eventPageTotal, setEventPageTotal] = useState<number | null>(null);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);

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
      pull('replace');
      const every = Math.max(pollIntervalSec, 10) * 1000;
      const id = setInterval(() => pull('replace'), every);
      return () => {
     live = false;
     clearInterval(id);
      };
    }, [pollIntervalSec]);

  /* Deep links: ?q=<mac> (client drawer's Auth history), ?plane=<registryId>
     (Systems plane drawer). Applied when the URL changes while the screen is
     mounted — state adjusted during render, the React-docs pattern for
     deriving from a changed prop, rather than an effect that commits the
     stale filter first. */
  const [prevParams, setPrevParams] = useState(searchParams);
  if (prevParams !== searchParams) {
    setPrevParams(searchParams);
    const qp = searchParams.get('q');
    if (qp !== null) setQ(qp);
    const pp = searchParams.get('plane');
    if (pp !== null) setPlane(planeFilterForParam(pp));
  }

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const events = data.events;
  const ql = q.trim().toLowerCase();
  const rows = events.filter(
    (e) =>
      (result === 'all' || e.result === result) &&
      (service === 'all' || e.service === service) &&
      (plane === 'all' || e.plane === plane) &&
      withinTimeRange(e.at, timeRange, nowMs) &&
      (!ql || (e.who + e.mac + e.reason + e.nas + e.role).toLowerCase().includes(ql)),
  );

  const serviceOptions = [{ value: 'all', label: 'All services' }].concat(
    uniq(events, 'service').map((v) => ({ value: v, label: v })),
  );
  const planeOptions = [{ value: 'all', label: 'All planes' }].concat(
    uniq(events, 'plane').map((v) => ({ value: v, label: v })),
  );
  /* A ?plane= deep-link (Systems plane drawer) can name a plane that has no rows
     in this feed. Without its own option the Select renders blank and the filter
     hiding every row is invisible and unclearable — so union the active value in. */
  if (plane !== 'all' && !planeOptions.some((o) => o.value === plane)) {
    planeOptions.push({ value: plane, label: `${plane} (no events)` });
  }

  /* This screen is fed by one plane (ClearPass), and the poller keeps serving a
   * degraded plane's last-good rows — so the header has to say when they were
   * pulled, and whether they are fixtures at all (README design rule 1). */
  const sectionLive = data.dataSource === 'live' || (data.blended?.includes('authEvents') ?? false);
  const synced = sectionLive ? `SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : '—'}` : 'SYNCED 09:41';

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
    <div className="nt-stack">
      <ScreenHeader
        overline="Operate / Auth events"
        title="Auth & policy events"
        subtitle="Every RADIUS decision, whichever plane asked the question."
        actions={
          <>
            <span className="nt-mono-label">
              {synced}
            </span>
            {data.blended?.includes('authEvents') ? <Badge tone="info">LIVE</Badge> : null}
            <Button variant="ghost" size="sm" onClick={() => navigate('/clients')}>
              Clients →
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const next = new URLSearchParams();
                  if (q.trim()) next.set('q', q.trim());
                  if (plane !== 'all') next.set('plane', plane);
                  if (timeRange !== 'all') next.set('range', timeRange);
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

      <StatRow stats={data.stats} />
      <VisualReferencePanel target={{ kind: 'service', id: 'auth-events' }} />
      <ConfigRecommendationsPanel title="Auth / policy recommendations" limit={5} />

      <div className="nt-filter-bar">
        <div className="nt-filter-field nt-filter-field--xl" style={{ width: 250 }}>
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
        <div className="nt-filter-field nt-filter-field--lg" style={{ width: 200 }}>
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
            options={planeOptions}
            value={plane}
            onValueChange={setPlane}
            size="sm"
            aria-label="Plane"
          />
        </div>
        <TimeRangeControl value={timeRange} onValueChange={setTimeRange} />
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
            className="nt-service-note" style={{ flexBasis: "100%" }}
          >
            {rangeCaveats.join(' ')}
          </span>
        ) : null}
      </div>

      <Table density={density}>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell>Time</Table.HeaderCell>
            <Table.HeaderCell>Endpoint</Table.HeaderCell>
            <Table.HeaderCell>Service</Table.HeaderCell>
            <Table.HeaderCell>Method</Table.HeaderCell>
            <Table.HeaderCell>Result</Table.HeaderCell>
            <Table.HeaderCell>Reason / role</Table.HeaderCell>
            <Table.HeaderCell>NAS device</Table.HeaderCell>
            <Table.HeaderCell>Plane</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {rows.map((e, i) => (
            <Table.Row key={`${e.time}-${i}`}>
              <Table.Cell>
                <span
                  className="nt-hint-muted"
                >
                  {e.at ? hhmmssLocal(e.at) : e.time}
                </span>
              </Table.Cell>
              <Table.Cell>
                <button
                  type="button"
                  onClick={() => navigate(`/clients?mac=${encodeURIComponent(e.mac)}`)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
                    {e.who}
                  </span>
                  <span
                    className="nt-hint-muted"
                  >
                    {e.mac}
                  </span>
                </button>
              </Table.Cell>
              <Table.Cell>{e.service}</Table.Cell>
              <Table.Cell>
                <span
                  className="nt-mono-11" style={{ color: "var(--nd-text-secondary)" }}
                >
                  {e.method}
                </span>
              </Table.Cell>
              <Table.Cell>
                <Badge tone={e.tone} dot>
                  {e.result}
                </Badge>
              </Table.Cell>
              <Table.Cell>
                <div className="nt-stack nt-gap-2">
                  <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-secondary)' }}>
                    {e.reason}
                  </span>
                  <span
                    className="nt-hint-muted"
                  >
                    {e.role}
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>
                <button
                  type="button"
                  onClick={() => navigate(deviceDetailPath({ name: e.nas, plane: e.plane }))}
                  className="nt-mono-link"
                  style={{ textAlign: 'left' }}
                >
                  {e.nas}
                </button>
              </Table.Cell>
              <Table.Cell>
                {showPlatformTags ? <Badge tone="neutral">{e.plane}</Badge> : null}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {eventHasMore ? (
        <div className="nt-center-pad" style={{ padding: '8px 0' }}>
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
            title="Nothing matches that filter"
            description={
              timeRange === 'all'
                ? 'Loosen the result, service or plane filter to see more of the log.'
                : 'Loosen the result, service or plane filter — or widen the time range — to see more of the log.'
            }
          />
        )
      ) : null}

      <Divider variant="flair" />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 34,
          alignItems: 'start',
        }}
      >
        <div className="nt-stack nt-gap-14">
          {/* The live bars count rejects out of the poller's ≤200-event page —
              minutes of traffic, not a day. Only the fixture feed is a 24h cut. */}
          <SectionHeader
            label="Why authentications failed"
            meta={sectionLive ? 'CURRENT POLLER SNAPSHOT' : 'LAST 24 HOURS'}
          />
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
          <SectionHeader label="Policy services" meta="AUTHS / HOUR" />
          {data.policyServices.length === 0 ? (
            <span
              className="nt-service-note" style={{ padding: "10px 0" }}
            >
              No policy service reported by a linked plane.
            </span>
          ) : null}
          {data.policyServices.map((s) => (
            <div
              key={s.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 0',
                borderBottom: '1px solid var(--nd-border-subtle)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
                  {s.name}
                </div>
                <div
                  className="nt-hint-muted"
                >
                  {s.detail}
                </div>
              </div>
              <span
                className="nt-mono-11" style={{ color: "var(--nd-text-secondary)", width: 64, textAlign: "right" }}
              >
                {s.rate}
              </span>
              <Badge tone={s.tone}>{s.state}</Badge>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
