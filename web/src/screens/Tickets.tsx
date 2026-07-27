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
import { Alert, Badge, Button, EmptyState, Heading, SectionHeader, Spinner, Textarea, useToast } from '../nightdesk';
import { addTicketNote, getTickets, resolveTicket } from '../api/client';
import type { TicketsData } from '../api/client';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';

type TicketNote = NonNullable<TicketsData['tickets'][number]['notes']>[number];

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function Tickets() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<TicketsData | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notesByTicket, setNotesByTicket] = useState<Record<string, TicketNote[]>>({});

  useEffect(() => {
    let live = true;
    void getTickets().then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const tickets = data.tickets;
  const cur = tickets.find((t) => t.id === searchParams.get('sel')) ?? tickets[0];

  if (!cur) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
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
  const firstDevice = cur.evidence.find((e) => e.device)?.device ?? null;

  const logEntry = async (text: string, kind: 'note' | 'action', done: string) => {
    setBusy(true);
    const res = await addTicketNote(cur.id, text, kind);
    setBusy(false);
    if ('ticket' in res) {
      setNotesByTicket((prev) => ({ ...prev, [cur.id]: res.ticket.notes ?? [] }));
      toast(done, { tone: 'success' });
    } else {
      toast(`not logged — ${res.error}`, { tone: 'danger' });
    }
  };

  const queueAction = (label: string) =>
    void logEntry(label, 'action', `${label} — logged on ${cur.id}, pending execution`);

  const addNote = () => {
    const text = note.trim();
    if (!text) return;
    setNote('');
    void logEntry(text, 'note', `Note saved to ${cur.id}`);
  };

  const resolveCurrent = async () => {
    setBusy(true);
    const res = await resolveTicket(cur.id);
    setBusy(false);
    if ('ticket' in res) {
      toast(`${cur.id} resolved`, { tone: 'success' });
      setData(await getTickets()); // the queue's open count + state badge follow the store
    } else {
      toast(`not resolved — ${res.error}`, { tone: 'danger' });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Operate / Tickets"
        title="Tickets"
        subtitle="One ticket, one workspace — evidence pulled from whichever plane owns the device."
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '300px minmax(0, 1fr)',
          gap: 32,
          alignItems: 'start',
        }}
      >
        {/* ---------------- queue ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader label="Queue" meta={`${openCount} open`} />
          {tickets.map((t) => {
            const selected = t.id === cur.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSearchParams({ sel: t.id }, { replace: true })}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  alignItems: 'stretch',
                  textAlign: 'left',
                  border: 'none',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                  borderLeft: `2px solid ${selected ? 'var(--nd-accent)' : 'transparent'}`,
                  background: selected ? 'var(--nd-bg-raised)' : 'transparent',
                  padding: '11px 10px',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 11,
                      color: 'var(--nd-accent-text)',
                    }}
                  >
                    {t.id}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10,
                      color: 'var(--nd-text-muted)',
                      marginLeft: 'auto',
                    }}
                  >
                    {t.age}
                  </span>
                </div>
                <span style={{ fontSize: 13, color: 'var(--nd-text-primary)', lineHeight: 1.35 }}>
                  {t.title}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Badge tone={t.tone}>{t.pri}</Badge>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10,
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {t.siteName}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* ---------------- workspace ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 12,
                  color: 'var(--nd-accent-text)',
                  letterSpacing: '.06em',
                }}
              >
                {cur.id}
              </span>
              <Badge tone={cur.tone} dot>
                {cur.pri}
              </Badge>
              <Badge tone="neutral">{cur.state}</Badge>
              <span
                style={{
                  marginLeft: 'auto',
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 11,
                  color: 'var(--nd-warning)',
                }}
              >
                {cur.sla}
              </span>
            </div>
            <Heading level={3}>{cur.title}</Heading>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: 18,
                padding: '14px 0',
                borderTop: '1px solid var(--nd-border-subtle)',
                borderBottom: '1px solid var(--nd-border-subtle)',
              }}
            >
              {(
                [
                  ['Reported by', cur.reporter],
                  ['Site', cur.siteName],
                  ['Owner', cur.owner],
                  ['Planes touched', cur.planes],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <div
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10,
                      letterSpacing: '.12em',
                      textTransform: 'uppercase',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-muted)',
                    width: 46,
                    flex: '0 0 46px',
                    paddingTop: 2,
                  }}
                >
                  {e.time}
                </span>
                <div style={{ width: 88, flex: '0 0 88px', paddingTop: 1 }}>
                  <Badge tone="neutral">{e.plane}</Badge>
                </div>
                <div
                  style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}
                >
                  <span style={{ fontSize: 13, color: 'var(--nd-text-primary)', lineHeight: 1.4 }}>
                    {e.finding}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10.5,
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {e.raw}
                  </span>
                </div>
                {e.device ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/devices/${encodeURIComponent(e.device as string)}`)}
                  >
                    {e.device}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>

          {/* ---------------- next actions + note ---------------- */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SectionHeader label="Next actions" />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button
                variant="primary"
                size="sm"
                disabled={!firstDevice}
                title={firstDevice ? undefined : 'no device in the evidence list to inspect'}
                onClick={() => firstDevice && navigate(`/devices/${encodeURIComponent(firstDevice)}`)}
              >
                {cur.action1}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => queueAction(cur.action2)}>
                {cur.action2}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => queueAction(cur.action3)}>
                {cur.action3}
              </Button>
              <Button
                variant="ghost"
                size="sm"
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 620 }}>
              <Textarea
                rows={3}
                placeholder="Log a note — saved to the ticket record in this portal."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Button variant="secondary" size="sm" disabled={!note.trim() || busy} onClick={addNote}>
                  Log note
                </Button>
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  Persisted in the portal's ticket store — survives refresh
                </span>
              </div>
              {notes.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
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
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10,
                          color: 'var(--nd-text-muted)',
                          width: 46,
                          flex: '0 0 46px',
                          paddingTop: 2,
                        }}
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
                        {n.kind === 'action' ? (
                          <span
                            style={{
                              fontFamily: 'var(--nd-font-mono)',
                              fontSize: 9.5,
                              letterSpacing: '.1em',
                              color: 'var(--nd-accent-text)',
                              marginRight: 8,
                            }}
                          >
                            ACTION
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
