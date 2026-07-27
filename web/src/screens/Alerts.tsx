/**
 * web/src/screens/Alerts.tsx — the de-duplicated queue across all planes.
 * High-fidelity port of design/NtAlerts.dc.html: danger correlation Alert,
 * filter row (severity Select 150px, plane Select 170px, mono Input 230px,
 * "Unacknowledged only" Switch, right-aligned mono `N of M` count), open table
 * Sev/Alert/Site/Plane/State/Age/Inspect. Filters are local, instant and
 * additive (AND); an empty result shows the EmptyState.
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
import type { AlertRow, TicketRow } from '../../../shared';
import { useSettings } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';

const SEV_OPTIONS = [
  { value: 'all', label: 'All severities' },
  { value: 'P1', label: 'P1 — critical' },
  { value: 'P2', label: 'P2 — major' },
  { value: 'P3', label: 'P3 — minor' },
];

export default function Alerts() {
  const navigate = useNavigate();
  const { density, showPlatformTags } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<AlertsData | null>(null);
  const [sev, setSev] = useState('all');
  const [plane, setPlane] = useState('all');
  const [q, setQ] = useState('');
  const [unackedOnly, setUnackedOnly] = useState(false);

  /* Ticket-gated acknowledge (Central's notifications clear API). The confirm
   * block lives inline under the header; it targets the first open alert in
   * the filtered view, snapshotted when the block opens. */
  const [ackTarget, setAckTarget] = useState<AlertRow | null>(null);
  const [ackTickets, setAckTickets] = useState<TicketRow[]>([]);
  const [ackTicket, setAckTicket] = useState('');
  const [ackBusy, setAckBusy] = useState(false);

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
    });
    return () => {
      live = false;
    };
  }, [ackTarget]);

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
    toast(res.applied ? `Acknowledge accepted — ${ackTarget.title.slice(0, 48)}` : 'Acknowledge logged, not sent', {
      description: res.message,
      tone: res.applied ? 'success' : 'warning',
    });
    if (res.applied) {
      // The plane accepted — reflect it now instead of waiting for the next poll.
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
      (sev === 'all' || a.sev === sev) &&
      (plane === 'all' || a.plane === plane) &&
      (!unackedOnly || a.state === 'open') &&
      (!ql || (a.title + a.detail + a.siteName).toLowerCase().includes(ql)),
  );
  const planes = ['all'].concat(
    data.alerts.map((a) => a.plane).filter((p, i, arr) => arr.indexOf(p) === i),
  );
  const planeOptions = planes.map((p) => ({ value: p, label: p === 'all' ? 'All planes' : p }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Operate / Alerts"
        title="Alerts"
        subtitle="Every plane's alarms in one queue, de-duplicated and aged."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const top = rows.find((a) => a.state === 'open');
                if (!top) {
                  toast('No open alert in view to acknowledge', { tone: 'info' });
                  return;
                }
                setAckTarget(top);
              }}
            >
              Acknowledge
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                const top = rows.find((a) => a.state === 'open') ?? rows[0];
                if (!top) {
                  toast('No alert in view to raise from', { tone: 'info' });
                  return;
                }
                const r = await raiseTicket(top);
                if ('ticket' in r) {
                  toast(`Ticket ${r.ticket.id} raised — ${top.title.slice(0, 48)}`, { tone: 'success' });
                  navigate(`/tickets?sel=${encodeURIComponent(r.ticket.id)}`);
                } else {
                  toast(`Ticket raise unavailable (${r.error}) — opening the queue`, { tone: 'info' });
                  navigate('/tickets');
                }
              }}
            >
              Raise ticket
            </Button>
          </>
        }
      />

      <Alert tone="danger" title="Riverside Clinic is dark — and its plane is stale">
        <span style={{ fontSize: 13 }}>
          WAN down 12 minutes. Central Classic last synced 6h ago, so device state there cannot be
          trusted. The local collector still answers on 10.51.0.0/24 — inspect sw-riv-1 over SSH
          instead.
        </span>
      </Alert>

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
              help={`Clears "${ackTarget.title.slice(0, 64)}" on ${ackTarget.plane === 'CENTRAL' ? 'Central via the notifications API (202 = accepted)' : `the ${ackTarget.plane} plane`}; recorded against this ticket.`}
            >
              <Select
                options={ackTickets.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))}
                value={ackTicket}
                onValueChange={setAckTicket}
                aria-label="Authorising ticket"
              />
            </FormField>
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={ackBusy || !ackTicket}
            onClick={() => void confirmAck()}
          >
            {ackBusy ? 'Acknowledging…' : 'Acknowledge'}
          </Button>
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
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-muted)',
          }}
        >
          {rows.length} of {data.alerts.length} alerts
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
          {rows.map((a) => (
            <Table.Row key={a.title}>
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
              <Table.Cell>{showPlatformTags ? <Badge tone="neutral">{a.plane}</Badge> : null}</Table.Cell>
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
              <Table.Cell numeric>{a.age}</Table.Cell>
              <Table.Cell>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate(`/devices/${encodeURIComponent(a.device)}`)}
                >
                  Inspect
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing matches that filter"
          description="Loosen the severity or plane filter to see the rest of the queue."
        />
      ) : null}
    </div>
  );
}
