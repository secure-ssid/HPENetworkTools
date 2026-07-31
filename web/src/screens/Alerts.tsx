/**
 * web/src/screens/Alerts.tsx — the de-duplicated queue across all planes.
 * High-fidelity port of design/NtAlerts.dc.html: danger correlation Alert,
 * filter row (severity Select 150px, plane Select 170px, mono Input 230px,
 * "Unacknowledged only" Switch, right-aligned mono `N of M` count), open table
 * Sev/Alert/Site/Plane/State/Age/Inspect. Filters are local, instant and
 * additive (AND); an empty result shows the EmptyState.
 * The banner is a served correlation when the payload carries one, else
 * authored prose for a demo-sourced queue and a correlation derived from the
 * rows for a live/blended one — by the SAME rule the server applies
 * (shared/logic.ts correlateAlerts), so the two can never name a different
 * worst finding; rows from a plane that is behind read `unverified`, never a
 * current age.
 * Data: getAlerts() — live /api/alerts when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FormField,
  Input,
  Select,
  Spinner,
  Switch,
  Table,
  useToast,
} from '../nightdesk';
import { ackAlert, getAlerts, getTickets, raiseTicket } from '../api/client';
import type { AlertsData } from '../api/client';
import { correlateAlerts } from '@hpe/shared';
import type { AlertCorrelation, AlertRow, TicketRow } from '@hpe/shared';
import { useSettings } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';

const SEV_OPTIONS = [
  { value: 'all', label: 'All severities' },
  { value: 'P1', label: 'P1 — critical' },
  { value: 'P2', label: 'P2 — major' },
  { value: 'P3', label: 'P3 — minor' },
];

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

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
 * Stable row identity. Titles are NOT unique in live data — Central's v1alpha1
 * feed titles every affected device 'Config Out of Sync', and dedupeAlerts keeps
 * them all (two devices are two findings). Keying on the title collides, so an
 * optimistic ack can visibly land on the wrong row. Match the server's dedupe
 * key when the plane gave us one; fall back to the sorted position.
 */
function rowKey(a: AlertRow, i: number): string {
  return a.alertId ? `${a.plane}|${a.alertId}` : `${a.plane}|${a.title}|${a.device}|${i}`;
}

/** Toast-safe rendering of an unknown thrown value. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function Alerts() {
  const navigate = useNavigate();
  const { density, showPlatformTags } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<AlertsData | null>(null);
  const [sev, setSev] = useState('all');
  const [plane, setPlane] = useState('all');
  const [q, setQ] = useState('');
  const [unackedOnly, setUnackedOnly] = useState(false);
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
      rows.find((a) => a.state === 'open' && a.device.trim()) ??
      rows.find((a) => a.state === 'open') ??
      rows[0];
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
      // correct it the moment it genuinely clears.
      const target = ackTarget;
      setData((d) => (d ? { ...d, alerts: d.alerts.map((a) => (a === target ? { ...a, state: 'acked' } : a)) } : d));
    }
    setAckTarget(null);
  };

  useEffect(() => {
    let live = true;
    void getAlerts().then((d) => {
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

  const ql = q.trim().toLowerCase();
  const rows = data.alerts.filter(
    (a) =>
      (showCleared || a.state !== 'cleared') &&
      (sev === 'all' || a.sev === sev) &&
      (plane === 'all' || a.plane === plane) &&
      (!unackedOnly || a.state === 'open') &&
      (!ql || (a.title + a.detail + a.siteName).toLowerCase().includes(ql)),
  );
  /* The denominator is the queue, and a row the plane already resolved is not in
   * it — counting cleared rows overstates the workload (README §2). */
  const clearedCount = data.alerts.filter((a) => a.state === 'cleared').length;
  const queueTotal = showCleared ? data.alerts.length : data.alerts.length - clearedCount;
  const planes = ['all'].concat(
    data.alerts.map((a) => a.plane).filter((p, i, arr) => arr.indexOf(p) === i),
  );
  const planeOptions = planes.map((p) => ({ value: p, label: p === 'all' ? 'All planes' : p }));

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
                const open = rows.filter((a) => a.state === 'open');
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
        <div style={{ width: 150 }}>
          <Select
            options={SEV_OPTIONS}
            value={sev}
            onValueChange={setSev}
            size="sm"
            aria-label="Severity"
          />
        </div>
        <div style={{ width: 170 }}>
          <Select
            options={planeOptions}
            value={plane}
            onValueChange={setPlane}
            size="sm"
            aria-label="Management plane"
          />
        </div>
        <div style={{ width: 230 }}>
          <Input
            size="sm"
            mono
            placeholder="filter text…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
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
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-muted)',
          }}
        >
          {`${rows.length} of ${queueTotal} alerts${
            clearedCount > 0 && !showCleared ? ` · ${clearedCount} cleared hidden` : ''
          } · ${sectionLive ? 'live' : 'demo fixtures'}`}
        </span>
      </div>

      <Table density={density}>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell>Sev</Table.HeaderCell>
            <Table.HeaderCell>Alert</Table.HeaderCell>
            <Table.HeaderCell>Site</Table.HeaderCell>
            <Table.HeaderCell>Plane</Table.HeaderCell>
            <Table.HeaderCell>State</Table.HeaderCell>
            <Table.HeaderCell numeric>Age</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {rows.map((a, i) => (
            <Table.Row key={rowKey(a, i)}>
              <Table.Cell>
                <Badge tone={a.tone} dot>
                  {a.sev}
                </Badge>
              </Table.Cell>
              <Table.Cell>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>{a.title}</span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10.5,
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {a.detail}
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>{a.siteName}</Table.Cell>
              <Table.Cell>
                {/* A row from a plane that is behind carries the design-rule-1
                    marker next to its plane badge — unverified, not current. */}
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {showPlatformTags ? <Badge tone="neutral">{a.plane}</Badge> : null}
                  {a.stale ? (
                    <Badge tone="warning" dot>
                      stale
                    </Badge>
                  ) : null}
                </span>
              </Table.Cell>
              <Table.Cell>
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color:
                      a.state === 'open' ? 'var(--nd-text-secondary)' : 'var(--nd-text-muted)',
                  }}
                >
                  {a.state}
                </span>
              </Table.Cell>
              <Table.Cell numeric>
                {a.stale ? (
                  <span style={{ color: 'var(--nd-text-muted)' }}>{a.age} · unverified</span>
                ) : (
                  a.age
                )}
              </Table.Cell>
              <Table.Cell>
                {/* Site/WAN/tenant-class live alerts honestly name no device
                    (central.ts:407-410) — Inspect would drop the operator on the
                    full inventory, so say so instead of offering a dead action. */}
                {a.device && a.device !== '—' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/devices/${encodeURIComponent(a.device)}`)}
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
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {/* An empty queue and an empty filter result are different facts: blaming
          a filter the operator never set implies alerts exist and are hidden. */}
      {rows.length === 0 ? (
        data.alerts.length === 0 ? (
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
        ) : (
          <EmptyState
            title="Nothing matches that filter"
            description="Loosen the severity or plane filter to see the rest of the queue."
          />
        )
      ) : null}
    </div>
  );
}
