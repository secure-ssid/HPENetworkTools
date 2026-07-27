/**
 * web/src/screens/AuthEvents.tsx — every RADIUS decision.
 * High-fidelity port of design/NtAuthEvents.dc.html: 5-Stat row, local AND
 * filter row (search / result / service / plane) with the right-aligned mono
 * count, the 8-column open table (endpoint MAC deep-links to /clients?mac=,
 * NAS device to /devices/:name), then a flair divider and two columns:
 * "Why authentications failed" (Progress bars, max=60) and "Policy services".
 * The search field honours ?q=<text> so the client drawer's "Auth history"
 * action lands pre-filtered.
 * Data: getAuthEvents() — live /api/auth-events when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Divider,
  EmptyState,
  Input,
  Progress,
  SectionHeader,
  Select,
  Spinner,
  Stat,
  Table,
  useToast,
} from '../nightdesk';
import { getAuthEvents } from '../api/client';
import type { AuthEventsData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { planeFilterForParam } from '../app/nav';
import type { AuthEventRow } from '../../../shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';

const RESULT_OPTIONS = [
  { value: 'all', label: 'All results' },
  { value: 'accept', label: 'Accepted' },
  { value: 'reject', label: 'Rejected' },
  { value: 'timeout', label: 'Timed out' },
];

function uniq<K extends keyof AuthEventRow>(events: AuthEventRow[], k: K): string[] {
  return events.map((e) => String(e[k])).filter((v, i, a) => a.indexOf(v) === i);
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function AuthEvents() {
  const navigate = useNavigate();
  const { density, showPlatformTags } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<AuthEventsData | null>(null);
  const [searchParams] = useSearchParams();
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [result, setResult] = useState('all');
  const [service, setService] = useState('all');
  const [plane, setPlane] = useState(() => planeFilterForParam(searchParams.get('plane')));

  useEffect(() => {
    let live = true;
    void getAuthEvents().then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, []);

  /* Deep links: ?q=<mac> (client drawer's Auth history), ?plane=<registryId>
     (Systems plane drawer). */
  useEffect(() => {
    const qp = searchParams.get('q');
    if (qp !== null) setQ(qp);
    const pp = searchParams.get('plane');
    if (pp !== null) setPlane(planeFilterForParam(pp));
  }, [searchParams]);

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const events = data.events;
  const ql = q.trim().toLowerCase();
  const rows = events.filter(
    (e) =>
      (result === 'all' || e.result === result) &&
      (service === 'all' || e.service === service) &&
      (plane === 'all' || e.plane === plane) &&
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Operate / Auth events"
        title="Auth & policy events"
        subtitle="Every RADIUS decision, whichever plane asked the question."
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
            {data.blended?.includes('authEvents') ? <Badge tone="info">LIVE</Badge> : null}
            <Button variant="ghost" size="sm" onClick={() => navigate('/clients')}>
              Clients →
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 18 }}>
        {data.stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} deltaTone={s.tone} />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 250 }}>
          <Input
            size="sm"
            mono
            placeholder="user, MAC, reason, NAS…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div style={{ width: 150 }}>
          <Select
            options={RESULT_OPTIONS}
            value={result}
            onValueChange={setResult}
            size="sm"
            aria-label="Result"
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            options={serviceOptions}
            value={service}
            onValueChange={setService}
            size="sm"
            aria-label="Service"
          />
        </div>
        <div style={{ width: 160 }}>
          <Select
            options={planeOptions}
            value={plane}
            onValueChange={setPlane}
            size="sm"
            aria-label="Plane"
          />
        </div>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-muted)',
          }}
        >
          {/* The daily-indexed tail is a fixture total the API never returns —
              a live/blended feed shows only what it actually holds. */}
          {rows.length} of {events.length} shown{sectionLive ? '' : ' · 1,904 events indexed today'}
        </span>
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
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {e.time}
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
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {e.mac}
                  </span>
                </button>
              </Table.Cell>
              <Table.Cell>{e.service}</Table.Cell>
              <Table.Cell>
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-secondary)',
                  }}
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-secondary)' }}>
                    {e.reason}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {e.role}
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>
                <button
                  type="button"
                  onClick={() => navigate(`/devices/${encodeURIComponent(e.nas)}`)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-accent-text)',
                    textAlign: 'left',
                  }}
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
            description="Loosen the result, service or plane filter to see more of the log."
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* The live bars count rejects out of the poller's ≤200-event page —
              minutes of traffic, not a day. Only the fixture feed is a 24h cut. */}
          <SectionHeader
            label="Why authentications failed"
            meta={sectionLive ? 'CURRENT POLLER SNAPSHOT' : 'LAST 24 HOURS'}
          />
          {data.failReasons.length === 0 ? (
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
                lineHeight: 1.6,
              }}
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
            <div key={r.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Progress value={r.value} max={60} label={r.label} />
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-10)',
                  color: 'var(--nd-text-muted)',
                }}
              >
                {r.note}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader label="Policy services" meta="AUTHS / HOUR" />
          {data.policyServices.length === 0 ? (
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
                lineHeight: 1.6,
                padding: '10px 0',
              }}
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
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-10)',
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {s.detail}
                </div>
              </div>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 11.5,
                  color: 'var(--nd-text-secondary)',
                  width: 64,
                  textAlign: 'right',
                }}
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
