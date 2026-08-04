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
 * first note). An open ticket can be closed with Resolve (POST
 * /api/tickets/:id/resolve — state 'resolved' plus an action note; the
 * queue refreshes so the open count and state badge stay honest).
 * Selection comes from ?sel=<ticketId> or the first ticket; the
 * URL is the source of truth so deep links stay shareable.
 * Data: getTickets() — live /api/tickets when the server is up, fixtures else.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  PageSkeleton, Alert, Badge, Button, EmptyState, Heading, SectionHeader, Textarea, useToast } from '../nightdesk';
import { addTicketNote, getTickets, resolveTicket } from '../api/client';
import type { TicketsData } from '../api/client';
import { hhmmLocal as hhmm, MAX_NOTE_CHARS, relativeAge, slaCountdown } from '@hpe/shared';
import type { TicketRow } from '@hpe/shared';
import { useSettings } from '../app/SettingsContext';
import { deviceDetailPath } from '../app/nav';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { exportTableCsv } from '../lib/csv';

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

export default function Tickets() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { pollIntervalSec } = useSettings();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<TicketsData | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notesByTicket, setNotesByTicket] = useState<Record<string, TicketNote[]>>({});
  /* Ages and SLA countdowns are measured against `now`, captured in state
     rather than recomputed per render (a bare Date.now() in render trips the
     compiler's purity rule) and refreshed with every poll below. */
  const [now, setNow] = useState(() => Date.now());

  /* The queue is a NOC artifact: poll on the settings cadence (the pattern
     Overview.tsx runs) so the open count, state badges and age/SLA countdowns
     cannot sit on a mount-time snapshot while the tab stays open. One fetch
     at a time — a slow response never stacks up behind the interval; fixture
     reads poll harmlessly. */
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = () => {
      if (inFlight) return;
      inFlight = true;
      void getTickets()
        .then((d) => {
          if (live) {
            setData(d);
            setNow(Date.now());
          }
        })
        .finally(() => {
          inFlight = false;
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

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const tickets = data.tickets;
  const cur = tickets.find((t) => t.id === searchParams.get('sel')) ?? tickets[0];

  if (!cur) {
    return (
      <div className="nt-tickets">
        <ScreenHeader
          overline="Operate / Tickets"
          title="Tickets"
          subtitle="One ticket, one workspace — evidence pulled from whichever plane owns the device."
        />
        <EmptyState title="No tickets in the queue" description="Raised tickets appear here with their cross-plane evidence." />
      </div>
    );
  }

  const openCount = tickets.filter((t) => t.state !== 'resolved').length;
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
      setData(await getTickets()); // the queue's open count + state badge follow the store
    } else {
      toast(`not resolved — ${res.error}`, { tone: 'danger' });
    }
  };

  return (
    <div className="nt-tickets">
      <ScreenHeader
        overline="Operate / Tickets"
        title="Tickets"
        subtitle="One ticket, one workspace — evidence pulled from whichever plane owns the device."
        actions={
          <>
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
                  description: 'tickets.csv — current queue snapshot.',
                });
              }}
            >
              Export CSV
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const url = `${window.location.origin}${window.location.pathname}?sel=${encodeURIComponent(cur.id)}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Ticket link copied', { description: cur.id, tone: 'success' });
                  } catch {
                    toast('Could not copy link', { description: url, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy ticket link
            </Button>
          </>
        }
      />

      <div className="nt-tickets__grid">
        {/* ---------------- queue ---------------- */}
        <div>
          <SectionHeader label="Queue" meta={`${openCount} open`} />
          <div className="nt-tickets__queue">
          {tickets.map((t) => {
            const selected = t.id === cur.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSearchParams({ sel: t.id }, { replace: true })}
                className={`nt-tickets__queue-item${selected ? ' nt-tickets__queue-item--active' : ''}`}
              >
                <div className="nt-row" style={{ alignItems: 'center', gap: 8 }}>
                  <span className="nt-tickets__id">{t.id}</span>
                  <span className="nt-tickets__age" style={{ marginLeft: 'auto' }}>{ageOf(t, now)}</span>
                </div>
                <span className="nt-tickets__title">{t.title}</span>
                <div className="nt-row" style={{ alignItems: 'center', gap: 6 }}>
                  <Badge tone={priTone(t)}>{t.pri}</Badge>
                  <span className="nt-tickets__site">{t.siteName}</span>
                </div>
              </button>
            );
          })}
          </div>
        </div>

        {/* ---------------- workspace ---------------- */}
        <div className="nt-tickets__workspace">
          <div className="nt-stack--tight">
            <div className="nt-row">
              <span className="nt-tickets__id" style={{ fontSize: 12, letterSpacing: '.06em' }}>
                {cur.id}
              </span>
              <Badge tone={priTone(cur)} dot>
                {cur.pri}
              </Badge>
              <Badge tone="neutral">{cur.state}</Badge>
              <span
                className={`nt-tickets__sla ${cur.state === 'resolved' ? 'nt-tickets__sla--done' : 'nt-tickets__sla--open'}`}
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
                  <div style={{ fontSize: 13, color: 'var(--nd-text-secondary)', marginTop: 3 }}>
                    {v}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Alert tone="info" title={cur.causeTitle}>
            <span style={{ fontSize: 13 }}>{cur.cause}</span>
          </Alert>

          {/* ---------------- evidence ---------------- */}
          <div className="nt-stack nt-gap-2">
            <SectionHeader label="Evidence, gathered across planes" meta="AUTO-COLLECTED" />
            {cur.evidence.map((e, i) => (
              <div
                key={`${e.time}-${i}`}
                style={{
                  display: 'flex',
                  gap: 14,
                  padding: '12px 0',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                }}
              >
                <span
                  className="nt-sync-row__time"
                >
                  {hhmm(e.time)}
                </span>
                <div style={{ width: 88, flex: '0 0 88px', paddingTop: 1 }}>
                  <Badge plane>{e.plane}</Badge>
                </div>
                <div
                  style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}
                >
                  <span style={{ fontSize: 13, color: 'var(--nd-text-primary)', lineHeight: 1.4 }}>
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
            <div className="nt-stack" style={{ gap: 8, maxWidth: 620 }}>
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
                    className="nt-hint-muted" style={{ color: "var(--nd-danger)" }}
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
                      style={{
                        display: 'flex',
                        gap: 10,
                        padding: '8px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span
                        className="nt-sync-row__time"
                      >
                        {hhmm(n.ts)}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12.5,
                          color: 'var(--nd-text-secondary)',
                          lineHeight: 1.4,
                        }}
                      >
                        {/* A retention marker records entries this ticket DROPPED.
                            It was badged RETAINED, directly above prose reading
                            "412 earlier entries discarded" — the label asserting
                            the opposite of the line it introduced, in the one
                            place the log admits to a hole in itself. */}
                        {n.kind === 'action' || n.kind === 'retention' ? (
                          <span
                            className="nt-mono-label"
                            style={{
                              color: n.kind === 'retention' ? 'var(--nd-warning)' : 'var(--nd-accent-text)',
                              marginRight: 8,
                            }}
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
    </div>
  );
}
