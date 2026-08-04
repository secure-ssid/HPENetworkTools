/**
 * web/src/screens/Tickets.tsx — ticket-driven troubleshooting.
 * High-fidelity port of design/NtTickets.dc.html: two columns (300px / 1fr).
 * Left: the five-ticket queue as selectable rows (selected = 2px copper left
 * border + bg-raised). Right: the workspace — id/priority/state/SLA line,
 * Heading level={3} title, four-up meta grid between hairlines, an info Alert
 * with the likely cause, the cross-plane evidence list (time gutter | plane
 * Badge | finding + raw | device drill-down), Next actions, and the note box.
 * Notes and requested actions POST to /api/tickets/:id/notes — they persist
 * in the portal's own ticket store (fixture tickets are promoted on their
 * first note). Draft text clears when ?sel= changes so a half-written note
 * cannot log against the wrong ticket. An open ticket can be closed with
 * Resolve (POST /api/tickets/:id/resolve — state 'resolved' plus an action
 * note; the queue refreshes so the open count and state badge stay honest).
 * Selection comes from ?sel=<ticketId> or the first ticket in the filtered
 * queue. Queue filters `?q=` (id/title/site/owner/reporter text), `?pri=`
 * (P1|P2|P3), `?state=` (open|in progress|waiting|resolved|openish) and
 * `?site=` (exact siteName, case-insensitive) write back as the operator
 * changes them so a shared URL restores the same slice; a **Priority** chip
 * row (counts over the q+state+site universe) toggles the same `?pri=` as the
 * header Select, a **State** chip row (counts over q+pri+site) toggles the
 * same `?state=` (Loop 140), and a **Site** chip row (counts over q+pri+state —
 * Loop 148) toggles the same `?site=`. Filtered empties offer **Clear filters**.
 * Header **LIVE** stamps pure live and blend feeds alike (Loop 159). **Copy
 * filter link** shares the queue slice (`q`/`pri`/`state`/`site`) without locking
 * `sel=`; **Copy view link** keeps the selected ticket. Live **Download server
 * CSV** passes the same filters and receives noteCount only (never note bodies).
 * Multi-select checkboxes on queue rows raise a bulk bar: **Export selected**,
 * **Copy IDs** (unique newline-joined ticket ids for paste into notes/handoffs —
 * Loop 171), **Copy titles** (unique newline-joined ticket titles when ids alone
 * are sparse for a handoff — Devices **Copy names** pattern; Loop 229),
 * **Copy selection link** (`?ids=` of marked ticket ids — Sites
 * `?ids=` pattern; clearable chip while active; Loop 175), and **Clear**.
 * Selection-empty `?ids=` offers **Clear selection filter** (Loop 210).
 * Queue header carries keyboard shortcuts help (`?` / DATATABLE_ROW_SHORTCUTS —
 * Loop 196). Workspace click (`sel=`) stays independent of the bulk mark set. Data:
 * getTickets({ limit, q, pri, state, site }) — live /api/tickets when the
 * server is up, fixtures else. Large queues page at TICKET_PAGE and Load more
 * via nextCursor.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  PageSkeleton,
  Alert,
  Badge,
  Button,
  Checkbox,
  DATATABLE_ROW_SHORTCUTS,
  EmptyState,
  Heading,
  Input,
  KeyboardShortcuts,
  SectionHeader,
  Select,
  Textarea,
  useToast,
} from '../nightdesk';
import { addTicketNote, getTickets, resolveTicket } from '../api/client';
import type { TicketsData } from '../api/client';
import { countOf, hhmmLocal as hhmm, MAX_NOTE_CHARS, relativeAge, slaCountdown } from '@hpe/shared';
import type { TicketRow } from '@hpe/shared';
import { useSettings } from '../app/SettingsContext';
import { useIncident } from '../app/IncidentContext';
import { deviceDetailPath, namesFilterForParam } from '../app/nav';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { VisualReferencePanel } from '../components/VisualReferencePanel';

/** Queue page size — raised tickets accumulate; optional server `page` envelope. */
const TICKET_PAGE = 50;

type TicketNote = NonNullable<TicketsData['tickets'][number]['notes']>[number];

/**
 * Age and SLA are rendered from the ticket's own timestamps whenever it has
 * them, so a queue fetched an hour ago (or an operator-raised ticket read from
 * the offline fixture path) cannot keep claiming a ticket raised days ago is
 * minutes old. Authored fixtures carry no `raisedAt`/`slaDueAt` — their strings
 * stay authoritative rather than being replaced by an invented countdown.
 */
function ageOf(t: TicketRow, now: number): string {
  return t.raisedAt ? relativeAge(t.raisedAt, now) : t.age;
}

/** A closed ticket has no countdown left to run — README rule 1. */
function slaOf(t: TicketRow, now: number): string {
  if (t.state === 'resolved') return 'Closed';
  return slaCountdown(t.slaDueAt, now) ?? t.sla;
}

/** Priority tone, neutralised once the ticket is closed (fixtures.ts NET-4149). */
function priTone(t: TicketRow): TicketRow['tone'] {
  return t.state === 'resolved' ? 'success' : t.tone;
}

const PRI_FILTERS = [
  { value: 'all', label: 'All priorities' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
] as const;

const STATE_FILTERS = [
  { value: 'all', label: 'All states' },
  { value: 'openish', label: 'Open queue' },
  { value: 'open', label: 'Open' },
  { value: 'in progress', label: 'In progress' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'resolved', label: 'Resolved' },
] as const;

type PriFilter = (typeof PRI_FILTERS)[number]['value'];
type StateFilter = (typeof STATE_FILTERS)[number]['value'];

function parsePriFilter(raw: string | null): PriFilter {
  if (raw === 'P1' || raw === 'P2' || raw === 'P3') return raw;
  return 'all';
}

function parseStateFilter(raw: string | null): StateFilter {
  if (
    raw === 'open' ||
    raw === 'in progress' ||
    raw === 'waiting' ||
    raw === 'resolved' ||
    raw === 'openish'
  ) {
    return raw;
  }
  return 'all';
}

function ticketMatchesState(t: TicketRow, state: StateFilter): boolean {
  if (state === 'all') return true;
  if (state === 'openish') return t.state !== 'resolved';
  return t.state === state;
}

/** Exact siteName or siteId (case-insensitive) — matches server `?site=`. */
function ticketMatchesSite(t: TicketRow, site: string): boolean {
  if (!site || site === 'all') return true;
  const needle = site.trim().toLowerCase();
  if (!needle) return true;
  const name = String(t.siteName ?? '')
    .trim()
    .toLowerCase();
  const id = String(t.siteId ?? '')
    .trim()
    .toLowerCase();
  return name === needle || id === needle;
}

/** Free-text match on operator-visible ticket fields (client-side demo fallback). */
function ticketMatchesQ(t: TicketRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [t.id, t.title, t.siteName, t.siteId, t.owner, t.reporter, t.planes, t.pri, t.state]
    .map((v) => String(v ?? ''))
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

function ticketInFilter(
  t: TicketRow,
  q: string,
  pri: PriFilter,
  state: StateFilter,
  site: string,
): boolean {
  return (
    ticketMatchesQ(t, q) &&
    (pri === 'all' || t.pri === pri) &&
    ticketMatchesState(t, state) &&
    ticketMatchesSite(t, site)
  );
}

export default function Tickets() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { pollIntervalSec } = useSettings();
  const { patchIncident } = useIncident();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<TicketsData | null>(null);
  const [q, setQ] = useState(() => searchParams.get('q')?.trim() ?? '');
  const [pri, setPri] = useState<PriFilter>(() => parsePriFilter(searchParams.get('pri')));
  const [state, setState] = useState<StateFilter>(() => parseStateFilter(searchParams.get('state')));
  const [site, setSite] = useState(() => {
    const s = searchParams.get('site')?.trim();
    return s || 'all';
  });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notesByTicket, setNotesByTicket] = useState<Record<string, TicketNote[]>>({});
  /* Ages and SLA countdowns are measured against `now`, captured in state
     rather than recomputed per render (a bare Date.now() in render trips the
     compiler's purity rule) and refreshed with every poll below. */
  const [now, setNow] = useState(() => Date.now());

  const ticketsAccRef = useRef<TicketRow[]>([]);
  const nextTicketCursorRef = useRef<string | null>(null);
  const loadMoreTicketsRef = useRef<() => void>(() => {});
  const [ticketHasMore, setTicketHasMore] = useState(false);
  const [ticketPageTotal, setTicketPageTotal] = useState<number | null>(null);
  const [loadingMoreTickets, setLoadingMoreTickets] = useState(false);
  /* Bulk mark set — independent of workspace `sel=` (Loop 171). */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /tickets?ids=a\nb (bulk Copy selection link). Read off the URL
   * like Sites ?ids= — must not drift from the address bar. Independent of `sel=`. */
  const idsFilter = namesFilterForParam(searchParams.get('ids'));

  /* The queue is a NOC artifact: poll on the settings cadence (the pattern
     Overview.tsx runs) so the open count, state badges and age/SLA countdowns
     cannot sit on a mount-time snapshot while the tab stays open. One fetch
     at a time — a slow response never stacks up behind the interval; fixture
     reads poll harmlessly. Live queues request optional pages (limit=50) so
     large raised-ticket stores can Load more without changing the full
     envelope contract for callers that omit limit. pri/state ride the same
     request so page.total matches the filter row (and Load more stays in the
     same slice). */
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const listQuery = () => ({
      limit: TICKET_PAGE,
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(pri !== 'all' ? { pri } : {}),
      ...(state !== 'all' ? { state } : {}),
      ...(site !== 'all' ? { site } : {}),
    });
    const pull = (mode: 'replace' | 'append' = 'replace') => {
      if (mode === 'replace' && inFlight) return;
      if (mode === 'append' && !nextTicketCursorRef.current) return;
      if (mode === 'replace') inFlight = true;
      if (mode === 'append') setLoadingMoreTickets(true);
      void getTickets({
        ...listQuery(),
        ...(mode === 'append' && nextTicketCursorRef.current
          ? { cursor: nextTicketCursorRef.current }
          : {}),
      })
        .then((d) => {
          if (!live) return;
          if (mode === 'append') {
            const seen = new Set(ticketsAccRef.current.map((t) => t.id));
            const extra = d.tickets.filter((t) => !seen.has(t.id));
            const merged = [...ticketsAccRef.current, ...extra];
            ticketsAccRef.current = merged;
            setData({ ...d, tickets: merged });
          } else {
            ticketsAccRef.current = d.tickets;
            setData(d);
          }
          nextTicketCursorRef.current = d.page?.nextCursor ?? null;
          setTicketHasMore(Boolean(d.page?.nextCursor));
          setTicketPageTotal(d.page?.total ?? null);
          setNow(Date.now());
        })
        .finally(() => {
          if (mode === 'replace') inFlight = false;
          if (mode === 'append') setLoadingMoreTickets(false);
        });
    };
    loadMoreTicketsRef.current = () => pull('append');
    // Filter change resets the cursor — never append across q/pri/state/site slices.
    nextTicketCursorRef.current = null;
    pull('replace');
    const every = Math.max(pollIntervalSec, 10) * 1000;
    const id = setInterval(() => pull('replace'), every);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pollIntervalSec, q, pri, state, site]);

  /* Keep ?q= / ?pri= / ?state= / ?site= aligned with the filter row (and preserve ?sel=
   * plus selection deep-link `ids=` — Copy selection link owns that param). */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const qt = q.trim();
    if (qt) next.set('q', qt);
    else next.delete('q');
    if (pri !== 'all') next.set('pri', pri);
    else next.delete('pri');
    if (state !== 'all') next.set('state', state);
    else next.delete('state');
    if (site !== 'all') next.set('site', site);
    else next.delete('site');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [q, pri, state, site, searchParams, setSearchParams]);

  /* Re-seed when the address bar changes externally (shared link / back). */
  const [prevParams, setPrevParams] = useState(searchParams);
  if (prevParams !== searchParams) {
    setPrevParams(searchParams);
    const fromUrl = searchParams.get('q')?.trim() ?? '';
    if (q !== fromUrl) setQ(fromUrl);
    const fromPri = parsePriFilter(searchParams.get('pri'));
    if (pri !== fromPri) setPri(fromPri);
    const fromState = parseStateFilter(searchParams.get('state'));
    if (state !== fromState) setState(fromState);
    const fromSite = searchParams.get('site')?.trim() || 'all';
    if (site !== fromSite) setSite(fromSite);
  }

  /* Workspace ticket id under the current filter/selection — used so draft
   * notes clear when the operator moves to another row (filter or click),
   * not merely when ?sel= is first written for the same ticket. */
  const workspaceTicketId = (() => {
    if (!data || data.apiError) return null;
    const filtered = data.tickets.filter(
      (t) =>
        ticketInFilter(t, q, pri, state, site) &&
        (idsFilter === null || idsFilter.includes(t.id)),
    );
    return filtered.find((t) => t.id === searchParams.get('sel'))?.id ?? filtered[0]?.id ?? null;
  })();

  /* Draft notes belong to one ticket. Changing the workspace ticket must
   * empty the box so a half-written incident note cannot land on the next
   * row under Log note — the store would accept it honestly against the wrong id. */
  const [prevTicketId, setPrevTicketId] = useState(workspaceTicketId);
  if (prevTicketId !== workspaceTicketId) {
    setPrevTicketId(workspaceTicketId);
    setNote('');
  }

  /* Keep the global incident spine on the open ticket so triage carries
   * alert → device → ticket context across screens. */
  useEffect(() => {
    if (!data || data.apiError) return;
    const filtered = data.tickets.filter(
      (t) =>
        ticketInFilter(t, q, pri, state, site) &&
        (idsFilter === null || idsFilter.includes(t.id)),
    );
    const cur = filtered.find((t) => t.id === searchParams.get('sel')) ?? filtered[0];
    if (!cur || cur.state === 'resolved') return;
    const deviceEv = cur.evidence.find((e) => e.device);
    const qs = new URLSearchParams();
    qs.set('sel', cur.id);
    if (q.trim()) qs.set('q', q.trim());
    if (pri !== 'all') qs.set('pri', pri);
    if (state !== 'all') qs.set('state', state);
    if (site !== 'all') qs.set('site', site);
    if (idsFilter !== null) qs.set('ids', idsFilter.join('\n'));
    patchIncident({
      ticketId: cur.id,
      alertTitle: cur.title,
      deviceName: deviceEv?.device ?? undefined,
      devicePlane: deviceEv?.plane,
      sourcePath: `/tickets?${qs.toString()}`,
    });
  }, [data, searchParams, patchIncident, q, pri, state, site, idsFilter]);

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const allTickets = data.tickets;
  const siteOptions = (() => {
    const names = [
      ...new Set(allTickets.map((t) => String(t.siteName ?? '').trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    if (site !== 'all' && !names.includes(site)) names.unshift(site);
    return [{ value: 'all', label: 'All sites' }, ...names.map((n) => ({ value: n, label: n }))];
  })();
  const matchesIds = (t: TicketRow) => idsFilter === null || idsFilter.includes(t.id);
  const tickets = allTickets.filter(
    (t) => ticketInFilter(t, q, pri, state, site) && matchesIds(t),
  );
  const cur = tickets.find((t) => t.id === searchParams.get('sel')) ?? tickets[0];
  const filtersActive =
    q.trim().length > 0 ||
    pri !== 'all' ||
    state !== 'all' ||
    site !== 'all' ||
    idsFilter !== null;
  /* Drop bulk marks that left the filtered queue (filter change / resolve). */
  const visibleIds = new Set(tickets.map((t) => t.id));
  const prunedKeys = selectedKeys.filter((id) => visibleIds.has(id));
  if (prunedKeys.length !== selectedKeys.length) setSelectedKeys(prunedKeys);
  /* Priority chips count over q+state+site+ids (not pri) so operators see the full
   * priority mix while a chip is active — same category-chip idea as Sites health.
   * Selection deep-link `ids=` narrows every universe. */
  const priUniverse = allTickets.filter(
    (t) => ticketInFilter(t, q, 'all', state, site) && matchesIds(t),
  );
  const PRI_CHIP_META: Array<{ key: Exclude<PriFilter, 'all'>; label: string; tone: 'danger' | 'warning' | 'info' }> = [
    { key: 'P1', label: 'P1', tone: 'danger' },
    { key: 'P2', label: 'P2', tone: 'warning' },
    { key: 'P3', label: 'P3', tone: 'info' },
  ];
  const priChips = PRI_CHIP_META.map((m) => ({
    ...m,
    count: priUniverse.filter((t) => t.pri === m.key).length,
  })).filter((c) => c.count > 0 || pri === c.key);
  /* State chips count over q+pri+site+ids (not state) — openish = non-resolved. */
  const stateUniverse = allTickets.filter(
    (t) => ticketInFilter(t, q, pri, 'all', site) && matchesIds(t),
  );
  const STATE_CHIP_META: Array<{
    key: Exclude<StateFilter, 'all'>;
    label: string;
    tone: 'danger' | 'warning' | 'info' | 'success' | 'neutral';
  }> = [
    { key: 'openish', label: 'Open queue', tone: 'danger' },
    { key: 'open', label: 'Open', tone: 'danger' },
    { key: 'in progress', label: 'In progress', tone: 'warning' },
    { key: 'waiting', label: 'Waiting', tone: 'info' },
    { key: 'resolved', label: 'Resolved', tone: 'success' },
  ];
  const stateChips = STATE_CHIP_META.map((m) => ({
    ...m,
    count: stateUniverse.filter((t) => ticketMatchesState(t, m.key)).length,
  })).filter((c) => c.count > 0 || state === c.key);
  /* Site chips count over q+pri+state+ids (not site) so the site mix stays visible
   * while a chip is active — Loop 148. */
  const siteUniverse = allTickets.filter(
    (t) => ticketInFilter(t, q, pri, state, 'all') && matchesIds(t),
  );
  const siteChipKeys = [
    ...new Set(siteUniverse.map((t) => String(t.siteName ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (site !== 'all' && !siteChipKeys.includes(site)) siteChipKeys.unshift(site);
  const siteChips = siteChipKeys
    .map((key) => ({
      key,
      label: key,
      count: siteUniverse.filter((t) => ticketMatchesSite(t, key)).length,
    }))
    .filter((c) => c.count > 0 || site === c.key);
  const idsPresent =
    idsFilter === null
      ? 0
      : idsFilter.filter((id) => allTickets.some((t) => t.id === id)).length;
  const clearTicketFilters = () => {
    setQ('');
    setPri('all');
    setState('all');
    setSite('all');
    if (idsFilter !== null) {
      const next = new URLSearchParams(searchParams);
      next.delete('ids');
      setSearchParams(next, { replace: true });
    }
    setSelectedKeys([]);
  };
  const selectionChip =
    idsFilter !== null ? (
      <div className="nt-chip-row" role="group" aria-label="Selection deep link">
        <button
          type="button"
          onClick={() => {
            const next = new URLSearchParams(searchParams);
            next.delete('ids');
            setSearchParams(next, { replace: true });
          }}
          title={idsFilter.join(', ')}
          className="nt-chip nt-chip--active"
        >
          {idsPresent === idsFilter.length
            ? `${idsFilter.length} selected ticket${idsFilter.length === 1 ? '' : 's'}`
            : `${idsPresent} of ${idsFilter.length} selected tickets present`}
          {' — clear'}
        </button>
      </div>
    ) : null;

  if (!cur) {
    return (
      <div className="nt-tickets nt-recon-reveal nt-tickets-shell nt-section-panel">
        <ScreenHeader
          overline="Operate / Tickets"
          title="Tickets"
          subtitle="One ticket, one workspace — evidence pulled from whichever plane owns the device."
          actions={
            <>
              <div className="nt-w-180">
                <Input
                  size="sm"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search id, title, site…"
                  aria-label="Search tickets"
                />
              </div>
              <div className="nt-w-140">
                <Select
                  options={[...PRI_FILTERS]}
                  value={pri}
                  onValueChange={(v) => setPri(parsePriFilter(v))}
                  size="sm"
                  aria-label="Filter by priority"
                />
              </div>
              <div className="nt-w-150">
                <Select
                  options={[...STATE_FILTERS]}
                  value={state}
                  onValueChange={(v) => setState(parseStateFilter(v))}
                  size="sm"
                  aria-label="Filter by state"
                />
              </div>
              <div className="nt-w-160">
                <Select
                  options={siteOptions}
                  value={site}
                  onValueChange={setSite}
                  size="sm"
                  aria-label="Filter by site"
                />
              </div>
            </>
          }
        />
        {priChips.length > 0 ? (
          <div className="nt-severity-chips nt-chip-row" role="group" aria-label="Ticket priority">
            <span className="nt-chip-row__label">Priority</span>
            {priChips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setPri(pri === c.key ? 'all' : c.key)}
                className={pri === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
                aria-pressed={pri === c.key}
              >
                <Badge tone={c.tone}>{c.label}</Badge>
                <span className="nt-chip__count">{c.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        {stateChips.length > 0 ? (
          <div className="nt-chip-row" role="group" aria-label="Ticket state">
            <span className="nt-chip-row__label">State</span>
            {stateChips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setState(state === c.key ? 'all' : c.key)}
                className={state === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
                aria-pressed={state === c.key}
                data-state={c.key}
              >
                <Badge tone={c.tone}>{c.label}</Badge>
                <span className="nt-chip__count">{c.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        {siteChips.length > 0 ? (
          <div className="nt-chip-row" role="group" aria-label="Ticket site">
            <span className="nt-chip-row__label">Site</span>
            {siteChips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setSite(site === c.key ? 'all' : c.key)}
                className={
                  site === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
                }
                aria-pressed={site === c.key}
                data-site={c.key}
              >
                <Badge tone="neutral">{c.label}</Badge>
                <span className="nt-chip__count">{c.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        {selectionChip}
        <EmptyState
          title={
            idsFilter !== null
              ? 'No tickets match this selection'
              : filtersActive
                ? 'No tickets match that filter'
                : 'No tickets in the queue'
          }
          description={
            idsFilter !== null
              ? 'Clear the selection filter to restore the ticket queue under the current search / priority / state / site filters.'
              : filtersActive
                ? 'Loosen search, priority, state, or site to see the rest of the queue.'
                : 'Raised tickets appear here with their cross-plane evidence.'
          }
        >
          {idsFilter !== null ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('ids');
                setSearchParams(next, { replace: true });
                setSelectedKeys([]);
              }}
            >
              Clear selection filter
            </Button>
          ) : filtersActive ? (
            <Button variant="secondary" size="sm" onClick={clearTicketFilters}>
              Clear filters
            </Button>
          ) : null}
        </EmptyState>
      </div>
    );
  }

  /* Open count is over the loaded pages only — page.total (when present) is the
     honest estate size; we never invent unresolved counts past what we hold. */
  const openCount = allTickets.filter((t) => t.state !== 'resolved').length;
  const sectionLive =
    data.dataSource === 'live' || (data.blended?.includes('tickets') ?? false);

  const writeTicketFilterParams = () => {
    const next = new URLSearchParams();
    if (q.trim()) next.set('q', q.trim());
    if (pri !== 'all') next.set('pri', pri);
    if (state !== 'all') next.set('state', state);
    if (site !== 'all') next.set('site', site);
    /* Filter link shares the queue slice without locking a bulk selection set. */
    return next;
  };

  const writeTicketParams = (ticketId: string) => {
    const next = writeTicketFilterParams();
    next.set('sel', ticketId);
    /* Keep bulk selection deep-link when jumping workspace rows. */
    if (idsFilter !== null) next.set('ids', idsFilter.join('\n'));
    return next;
  };
  const notes = notesByTicket[cur.id] ?? cur.notes ?? [];
  const overLimit = note.trim().length > MAX_NOTE_CHARS;
  const firstDevice = cur.evidence.find((e) => e.device)?.device ?? null;

  /** Resolves true only when the store took the entry. */
  const logEntry = async (text: string, kind: 'note' | 'action', done: string): Promise<boolean> => {
    setBusy(true);
    const res = await addTicketNote(cur.id, text, kind);
    setBusy(false);
    if ('ticket' in res) {
      setNotesByTicket((prev) => ({ ...prev, [cur.id]: res.ticket.notes ?? [] }));
      toast(done, { tone: 'success' });
      return true;
    }
    toast(`not logged — ${res.error}`, { tone: 'danger' });
    return false;
  };

  const queueAction = (label: string) =>
    void logEntry(label, 'action', `${label} — logged on ${cur.id}, pending execution`);

  const addNote = async () => {
    const text = note.trim();
    if (!text) return;
    // Checked here against the same shared constant the route enforces, so
    // the operator is stopped while still typing rather than after pressing
    // Log. The box is not truncated to fit: silently dropping the tail of an
    // incident note is the failure the refusal exists to prevent.
    if (text.length > MAX_NOTE_CHARS) {
      toast(`not logged — ${text.length} characters, the limit is ${MAX_NOTE_CHARS}`, { tone: 'danger' });
      return;
    }
    // The box empties only once the store has the note. Clearing it on submit
    // meant a rejected POST destroyed what the operator had typed — an
    // incident note is often the longest thing anyone writes in this portal,
    // and the red toast that replaced it carried no way to get the text back.
    if (await logEntry(text, 'note', `Note saved to ${cur.id}`)) setNote('');
  };

  const resolveCurrent = async () => {
    setBusy(true);
    const res = await resolveTicket(cur.id);
    setBusy(false);
    if ('ticket' in res) {
      toast(`${cur.id} resolved`, { tone: 'success' });
      // The refetched envelope is the single source of truth for the log —
      // drop the optimistic copy or the store's 'Ticket resolved' action note
      // stays invisible until a full reload.
      setNotesByTicket((prev) => {
        const next = { ...prev };
        delete next[cur.id];
        return next;
      });
      const refreshed = await getTickets({
        limit: TICKET_PAGE,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(pri !== 'all' ? { pri } : {}),
        ...(state !== 'all' ? { state } : {}),
        ...(site !== 'all' ? { site } : {}),
      });
      ticketsAccRef.current = refreshed.tickets;
      nextTicketCursorRef.current = refreshed.page?.nextCursor ?? null;
      setTicketHasMore(Boolean(refreshed.page?.nextCursor));
      setTicketPageTotal(refreshed.page?.total ?? null);
      setData(refreshed); // the queue's open count + state badge follow the store
    } else {
      toast(`not resolved — ${res.error}`, { tone: 'danger' });
    }
  };

  return (
    <div className="nt-tickets nt-recon-reveal nt-tickets-shell nt-section-panel">
      <ScreenHeader
        overline="Operate / Tickets"
        title="Tickets"
        subtitle="One ticket, one workspace — evidence pulled from whichever plane owns the device."
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              HPE Network Tools · queue
            </span>
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <div className="nt-w-180">
              <Input
                size="sm"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search id, title, site…"
                aria-label="Search tickets"
              />
            </div>
            <div className="nt-w-140">
              <Select
                options={[...PRI_FILTERS]}
                value={pri}
                onValueChange={(v) => setPri(parsePriFilter(v))}
                size="sm"
                aria-label="Filter by priority"
              />
            </div>
            <div className="nt-w-150">
              <Select
                options={[...STATE_FILTERS]}
                value={state}
                onValueChange={(v) => setState(parseStateFilter(v))}
                size="sm"
                aria-label="Filter by state"
              />
            </div>
            <div className="nt-w-160">
              <Select
                options={siteOptions}
                value={site}
                onValueChange={setSite}
                size="sm"
                aria-label="Filter by site"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const n = exportTableCsv(
                  'tickets.csv',
                  ['id', 'title', 'priority', 'state', 'site', 'age', 'sla'],
                  tickets.map((t) => [t.id, t.title, t.pri, t.state, t.siteName, ageOf(t, now), slaOf(t, now)]),
                );
                toast(`Exported ${n} ticket${n === 1 ? '' : 's'}`, {
                  description: 'tickets.csv — filtered queue snapshot.',
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
                    /* Same q/pri/state/site slice as the filter row and list GET — never
                     * a full-queue dump while the operator is looking at P1s. */
                    const exportQs = new URLSearchParams();
                    if (q.trim()) exportQs.set('q', q.trim());
                    if (pri !== 'all') exportQs.set('pri', pri);
                    if (state !== 'all') exportQs.set('state', state);
                    if (site !== 'all') exportQs.set('site', site);
                    const exportPath = exportQs.toString()
                      ? `/api/tickets/export?${exportQs.toString()}`
                      : '/api/tickets/export';
                    const res = await downloadApiCsv(exportPath, 'tickets.csv');
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description: 'tickets.csv — filtered queue (note counts only, no bodies).',
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
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const qs = writeTicketFilterParams().toString();
                  const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Filter link copied', {
                      description: qs || 'unfiltered ticket queue',
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy link', { description: url, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy filter link
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const qs = writeTicketParams(cur.id).toString();
                  const url = `${window.location.origin}${window.location.pathname}?${qs}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('View link copied', {
                      description: qs,
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy link', { description: url, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy view link
            </Button>
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </>
        }
      />
      <div className="nt-plane-theater" role="note">HPE Network Tools · queue theater · priority owns hue</div>
      <div className="nt-status-ribbon nt-tickets-ribbon" role="status" aria-label="Tickets status ribbon">
        <span className="nt-status-ribbon__item">queue · priority owns hue</span>
        <span className="nt-status-ribbon__item">alert → device → ticket</span>
        <span className="nt-status-ribbon__item">planes monochrome</span>
      </div>
      <nav className="nt-incident-spine" aria-label="Incident spine">
        <span className="nt-incident-spine__step">Alert</span>
        <span className="nt-incident-spine__chev" aria-hidden>→</span>
        <span className="nt-incident-spine__step">Device</span>
        <span className="nt-incident-spine__chev" aria-hidden>→</span>
        <span className="nt-incident-spine__step" data-active="true">Ticket</span>
      </nav>

      {priChips.length > 0 ? (
        <div className="nt-severity-chips nt-chip-row" role="group" aria-label="Ticket priority">
          <span className="nt-chip-row__label">Priority</span>
          {priChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setPri(pri === c.key ? 'all' : c.key)}
              className={pri === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={pri === c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {stateChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Ticket state">
          <span className="nt-chip-row__label">State</span>
          {stateChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setState(state === c.key ? 'all' : c.key)}
              className={state === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={state === c.key}
              data-state={c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {siteChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Ticket site">
          <span className="nt-chip-row__label">Site</span>
          {siteChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setSite(site === c.key ? 'all' : c.key)}
              className={
                site === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={site === c.key}
              data-site={c.key}
            >
              <Badge tone="neutral">{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {selectionChip}

      <div className="nt-tickets__grid">
        {/* ---------------- queue ---------------- */}
        <div>
          <SectionHeader
            label="Queue"
            meta={
              filtersActive
                ? `${tickets.length} shown · ${openCount} open loaded`
                : ticketPageTotal != null
                  ? `${openCount} open · ${allTickets.length} of ${ticketPageTotal}`
                  : `${openCount} open`
            }
          />
          <div className="nt-tickets__queue" aria-label="Ticket queue">
          {tickets.map((t) => {
            const selected = t.id === cur.id;
            const marked = selectedKeys.includes(t.id);
            return (
              <div key={t.id} className="nt-row nt-row-center nt-gap-6">
                <Checkbox
                  aria-label={`Select ticket ${t.id}`}
                  checked={marked}
                  onChange={() =>
                    setSelectedKeys((curKeys) =>
                      curKeys.includes(t.id) ? curKeys.filter((k) => k !== t.id) : [...curKeys, t.id],
                    )
                  }
                />
                <button
                  type="button"
                  onClick={() => setSearchParams(writeTicketParams(t.id), { replace: true })}
                  className={`nt-tickets__queue-item nt-queue-row nt-flex-1${selected ? ' nt-tickets__queue-item--active' : ''}${
                    t.pri === 'P1' || t.pri === 'P2' ? ' nt-tickets__queue-item--hot' : ''
                  }`}
                  data-pri={t.pri}
                  data-tone={priTone(t)}
                >
                  <div className="nt-row nt-row-center nt-gap-8">
                    <span className="nt-tickets__id">{t.id}</span>
                    <span className="nt-tickets__age nt-ml-auto">{ageOf(t, now)}</span>
                  </div>
                  <span className="nt-tickets__title">{t.title}</span>
                  <div className="nt-row nt-row-center nt-gap-6">
                    <Badge tone={priTone(t)}>{t.pri}</Badge>
                    <span className="nt-tickets__site">{t.siteName}</span>
                  </div>
                </button>
              </div>
            );
          })}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Ticket selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy ids/titles, or share a selection link for the tickets you marked — workspace click stays independent
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = tickets.filter((t) => selected.has(t.id));
                    if (picked.length === 0) {
                      toast('No selected tickets still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'tickets-selected.csv',
                      ['id', 'title', 'priority', 'state', 'site', 'age', 'sla'],
                      picked.map((t) => [
                        t.id,
                        t.title,
                        t.pri,
                        t.state,
                        t.siteName,
                        ageOf(t, now),
                        slaOf(t, now),
                      ]),
                    );
                    toast(`Exported ${countOf(n, 'selected ticket')}`, {
                      description: 'tickets-selected.csv — queue fields only (no notes).',
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
                      const picked = tickets.filter((t) => selected.has(t.id));
                      if (picked.length === 0) {
                        toast('No selected tickets still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const seen = new Set<string>();
                      const ids: string[] = [];
                      for (const t of picked) {
                        const id = String(t.id ?? '').trim();
                        if (!id || seen.has(id)) continue;
                        seen.add(id);
                        ids.push(id);
                      }
                      if (ids.length === 0) {
                        toast('No ticket ids on the selection', {
                          description: 'Use Copy titles or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = ids.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(ids.length, 'ticket id')}`, {
                          description: 'newline-joined · paste into a note or handoff',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy ticket ids', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy IDs
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = tickets.filter((t) => selected.has(t.id));
                      if (picked.length === 0) {
                        toast('No selected tickets still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const titles = [
                        ...new Set(
                          picked
                            .map((t) => String(t.title ?? '').trim())
                            .filter((title) => title && title !== '—'),
                        ),
                      ];
                      if (titles.length === 0) {
                        toast('No titles on the selected tickets', {
                          description: 'Those rows did not publish a title — export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = titles.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(titles.length, 'title')}`, {
                          description:
                            titles.length < picked.length
                              ? `${picked.length - titles.length} selected without a title skipped`
                              : 'newline-joined · paste into a note or handoff',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy titles', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy titles
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = tickets.filter((t) => selected.has(t.id));
                      if (picked.length === 0) {
                        toast('No selected tickets still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const ids = [
                        ...new Set(
                          picked
                            .map((t) => String(t.id ?? '').trim())
                            .filter(Boolean),
                        ),
                      ];
                      if (ids.length === 0) {
                        toast('No ticket ids on the selection', {
                          description: 'Use Copy titles or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('ids', ids.join('\n'));
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${ids.length} ticket${ids.length === 1 ? '' : 's'} · ids=`,
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
                <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                  Clear
                </Button>
              </span>
            </div>
          ) : null}
          {ticketHasMore || ticketPageTotal != null ? (
            <div className="nt-row nt-row-center nt-gap-8 nt-tickets__pager">
              {ticketPageTotal != null ? (
                <span className="nt-fs-12-muted">
                  Loaded {allTickets.length} of {ticketPageTotal}
                </span>
              ) : null}
              {ticketHasMore ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={loadingMoreTickets}
                  onClick={() => loadMoreTicketsRef.current()}
                >
                  {loadingMoreTickets ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
            </div>
          ) : null}
          </div>
        </div>

        {/* ---------------- workspace ---------------- */}
        <div className="nt-tickets__workspace nt-ticket-workspace">
          <div className="nt-stack--tight">
            <div className="nt-row">
              <span className="nt-tickets__id nt-ls-kicker">
                {cur.id}
              </span>
              <Badge tone={priTone(cur)} dot>
                {cur.pri}
              </Badge>
              <Badge tone="neutral">{cur.state}</Badge>
              <span
                className={`nt-tickets__sla nt-sla-chip ${cur.state === 'resolved' ? 'nt-tickets__sla--done' : 'nt-tickets__sla--open'}`}
                data-state={cur.state === 'resolved' ? 'met' : cur.pri === 'P1' ? 'at-risk' : 'ok'}
              >
                {slaOf(cur, now)}
              </span>
            </div>
            <Heading level={3}>{cur.title}</Heading>
            <div className="nt-tickets__meta-grid">
              {(
                [
                  ['Reported by', cur.reporter],
                  ['Site', cur.siteName],
                  ['Owner', cur.owner],
                  ['Planes touched', cur.planes],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <div className="nt-tickets__meta-k">
                    {k}
                  </div>
                  <div className="nt-fs-13-sec">
                    {v}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Alert tone="info" title={cur.causeTitle}>
            <span className="nt-fs-13">{cur.cause}</span>
          </Alert>

          {/* ---------------- evidence ---------------- */}
          <div className="nt-stack nt-gap-2">
            <SectionHeader label="Evidence, gathered across planes" meta="AUTO-COLLECTED" />
            {cur.evidence.map((e, i) => (
              <div
                key={`${e.time}-${i}`}
                className="nt-ticket-row"
              >
                <span
                  className="nt-sync-row__time"
                >
                  {hhmm(e.time)}
                </span>
                <div className="nt-w-96 nt-ticket-meta">
                  <Badge plane>{e.plane}</Badge>
                </div>
                <div
                  className="nt-ticket-body"
                >
                  <span className="nt-fs-13-primary">
                    {e.finding}
                  </span>
                  <span
                    className="nt-hint-muted"
                  >
                    {e.raw}
                  </span>
                </div>
                {e.device ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(deviceDetailPath({ name: e.device as string, plane: e.plane }))}
                  >
                    {e.device}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>

          {/* ---------------- next actions + note ---------------- */}
          <div className="nt-stack nt-gap-12">
            <SectionHeader label="Next actions" />
            <div className="nt-chip-wrap">
              <Button
                variant="primary"
                size="sm"
                disabled={!firstDevice}
                title={firstDevice ? undefined : 'no device in the evidence list to inspect'}
                onClick={() => firstDevice && navigate(`/devices/${encodeURIComponent(firstDevice)}`)}
              >
                {cur.action1}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => queueAction(cur.action2)}>
                {cur.action2}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => queueAction(cur.action3)}>
                {cur.action3}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => queueAction('Escalate to HPE support')}
              >
                Escalate to HPE support
              </Button>
              {cur.state !== 'resolved' ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void resolveCurrent()}>
                  Resolve ticket
                </Button>
              ) : null}
            </div>
            <div className="nt-stack nt-gap-8 nt-max-w-620">
              <Textarea
                rows={3}
                placeholder="Log a note — saved to the ticket record in this portal."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="nt-row nt-gap-10">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!note.trim() || busy || note.trim().length > MAX_NOTE_CHARS}
                  onClick={() => void addNote()}
                >
                  Log note
                </Button>
                {overLimit ? (
                  <span
                    className="nt-hint-muted nt-danger-text"
                  >
                    {note.trim().length} / {MAX_NOTE_CHARS} characters — too long to log. Nothing is
                    truncated; shorten it and the button comes back.
                  </span>
                ) : null}
                <span
                  className="nt-hint-muted"
                >
                  Persisted in the portal's ticket store — survives refresh · ServiceNow ref
                  INC0094{cur.inc} (correlation id only — nothing is mirrored from here)
                </span>
              </div>
              {notes.length > 0 ? (
                <div className="nt-stack nt-gap-0">
                  {notes.map((n, i) => (
                    <div
                      key={`${n.ts}-${i}`}
                      className="nt-ticket-note-row"
                    >
                      <span
                        className="nt-sync-row__time"
                      >
                        {hhmm(n.ts)}
                      </span>
                      <span
                        className="nt-ticket-note"
                      >
                        {/* A retention marker records entries this ticket DROPPED.
                            It was badged RETAINED, directly above prose reading
                            "412 earlier entries discarded" — the label asserting
                            the opposite of the line it introduced, in the one
                            place the log admits to a hole in itself. */}
                        {n.kind === 'action' || n.kind === 'retention' ? (
                          <span
                            className={[`nt-mono-label nt-mr-8`, n.kind === 'retention' ? 'nt-mr-8 nt-tone-warning' : 'nt-mr-8 nt-tone-accent'].filter(Boolean).join(" ")}
                          >
                            {n.kind === 'retention' ? 'DISCARDED' : 'ACTION'}
                          </span>
                        ) : null}
                        {n.text}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Reference material and advisory panels sit below the data they
          describe. Rendered above it they pushed the primary table several
          hundred pixels down the page — on a queue screen the queue is what
          the operator came for, not the suggestions about it. */}
      <VisualReferencePanel target={{ kind: 'service', id: 'tickets' }} editable={false} />
    </div>
  );
}
