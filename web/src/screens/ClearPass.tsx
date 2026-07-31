/**
 * web/src/screens/ClearPass.tsx — the endpoint policy screen.
 *
 * ClearPass owns two things the rest of the portal only borrows a slice of:
 * the endpoint repository (profiling — MAC, IP, hostname, category, OS,
 * enforcement profile) and the RADIUS auth feed (already the dedicated
 * /auth-events screen). This screen puts the repository front and centre with
 * a filterable table, and keeps a compact tail of the same auth feed so an
 * operator does not have to leave the plane's screen to see why an endpoint
 * was just quarantined.
 *
 * Data: getClearPass() — live /api/clearpass when the server is up, fixtures
 * otherwise (see web/src/api/screens.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  SectionHeader,
  Select,
  Spinner,
  Table,
} from '../nightdesk';
import { getClearPass } from '../api/client';
import type { ClearPassData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { hhmmssLocal } from '@hpe/shared';
import type { EndpointRow, StatDef, Tone } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';

const STATUS_TONE: Record<string, Tone> = {
  Known: 'success',
  Unknown: 'warning',
  Disabled: 'neutral',
};

function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? 'neutral';
}

function uniq(values: Array<string | null>): string[] {
  return values.filter((v): v is string => v !== null).filter((v, i, a) => a.indexOf(v) === i);
}

export default function ClearPass() {
  const navigate = useNavigate();
  const { density } = useSettings();
  const [data, setData] = useState<ClearPassData | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [category, setCategory] = useState('all');

  useEffect(() => {
    let live = true;
    void getClearPass().then((d) => {
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

  return <ClearPassView data={data} navigate={navigate} density={density} q={q} setQ={setQ} status={status} setStatus={setStatus} category={category} setCategory={setCategory} />;
}

function ClearPassView({
  data,
  navigate,
  density,
  q,
  setQ,
  status,
  setStatus,
  category,
  setCategory,
}: {
  data: ClearPassData;
  navigate: ReturnType<typeof useNavigate>;
  density: 'comfortable' | 'compact';
  q: string;
  setQ: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
}) {
  const endpoints = data.endpoints;
  const authEvents = data.authEvents;
  const missingSources = data.missingSources ?? [];

  const stats = useMemo<StatDef[]>(() => {
    const known = endpoints.filter((e) => e.status === 'Known').length;
    const unknown = endpoints.filter((e) => e.status === 'Unknown').length;
    const disabled = endpoints.filter((e) => e.status === 'Disabled').length;
    const total = endpoints.length;
    const pct = total > 0 ? Math.round((known / total) * 100) : 0;
    return [
      { label: 'Total endpoints', value: String(total), delta: 'endpoint repository', tone: 'neutral' },
      { label: 'Known', value: String(known), delta: `${pct}% of repository`, tone: 'positive' },
      { label: 'Unknown', value: String(unknown), delta: unknown > 0 ? 'needs profiling' : 'none unknown', tone: unknown > 0 ? 'negative' : 'neutral' },
      { label: 'Disabled', value: String(disabled), delta: 'access revoked', tone: 'neutral' },
      { label: 'Auth events', value: String(authEvents.length), delta: 'last 24h', tone: 'neutral' },
    ];
  }, [endpoints, authEvents]);

  const ql = q.trim().toLowerCase();
  const rows = endpoints.filter(
    (e) =>
      (status === 'all' || e.status === status) &&
      (category === 'all' || e.category === category) &&
      (!ql || (e.hostname ?? '' ).toLowerCase().includes(ql) || e.mac.toLowerCase().includes(ql) || (e.ip ?? '').toLowerCase().includes(ql)),
  );

  const statusOptions = [{ value: 'all', label: 'All statuses' }].concat(
    uniq(endpoints.map((e) => e.status)).map((v) => ({ value: v, label: v })),
  );
  const categoryOptions = [{ value: 'all', label: 'All categories' }].concat(
    uniq(endpoints.map((e) => e.category)).map((v) => ({ value: v, label: v })),
  );

  const recentAuth = authEvents.slice(0, 20);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Operate / ClearPass"
        title="ClearPass"
        subtitle="Endpoint policy, profiling, and authentication from HPE ClearPass."
        actions={
          <>
            {data.dataSource === 'live' ? <Badge tone="info">LIVE</Badge> : null}
            <Button variant="ghost" size="sm" onClick={() => navigate('/auth-events')}>
              Auth events →
            </Button>
          </>
        }
      />

      <StatRow stats={stats} />

      {missingSources.length > 0 ? (
        <Alert
          tone="warning"
          title={`${missingSources.length} linked plane${
            missingSources.length === 1 ? '' : 's'
          } contributed no ClearPass data: ${missingSources.join(', ')}`}
        >
          <span style={{ fontSize: 13 }}>
            The endpoint repository or auth feed has not come back from this plane — treat the counts above as
            a lower bound, not the whole estate.
          </span>
        </Alert>
      ) : null}

      <SectionHeader label="Endpoint repository" meta={`${rows.length} of ${endpoints.length} shown`} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 250 }}>
          <Input
            size="sm"
            mono
            placeholder="hostname, MAC, IP…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div style={{ width: 160 }}>
          <Select options={statusOptions} value={status} onValueChange={setStatus} size="sm" aria-label="Status" />
        </div>
        <div style={{ width: 180 }}>
          <Select
            options={categoryOptions}
            value={category}
            onValueChange={setCategory}
            size="sm"
            aria-label="Category"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        endpoints.length === 0 ? (
          <EmptyState
            title="No endpoints from any policy plane"
            description={
              data.dataSource === 'live'
                ? 'ClearPass has not returned endpoint rows yet — check Connected systems.'
                : 'No policy plane has an endpoint repository linked.'
            }
          >
            {data.dataSource === 'live' ? (
              <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                Connected systems
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <EmptyState
            title="Nothing matches that filter"
            description="Loosen the search, status or category filter to see more of the repository."
          />
        )
      ) : (
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>MAC</Table.HeaderCell>
              <Table.HeaderCell>Hostname</Table.HeaderCell>
              <Table.HeaderCell>IP</Table.HeaderCell>
              <Table.HeaderCell>Category</Table.HeaderCell>
              <Table.HeaderCell>OS / Family</Table.HeaderCell>
              <Table.HeaderCell>Profile</Table.HeaderCell>
              <Table.HeaderCell>Updated</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {rows.map((e) => (
              <EndpointTableRow key={e.id} row={e} onOpenAuth={() => navigate(`/auth-events?q=${encodeURIComponent(e.mac)}`)} />
            ))}
          </Table.Body>
        </Table>
      )}

      <SectionHeader label="Recent auth events" meta="LAST 20" />
      {recentAuth.length === 0 ? (
        <EmptyState
          title="No auth events in this window"
          description="ClearPass has not recorded a RADIUS decision recently."
        />
      ) : (
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Time</Table.HeaderCell>
              <Table.HeaderCell>Result</Table.HeaderCell>
              <Table.HeaderCell>Username</Table.HeaderCell>
              <Table.HeaderCell>MAC</Table.HeaderCell>
              <Table.HeaderCell>Method</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {recentAuth.map((ev, i) => (
              <Table.Row key={`${ev.time}-${i}`}>
                <Table.Cell>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-11)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {ev.at ? hhmmssLocal(ev.at) : ev.time}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Badge tone={ev.tone} dot>
                    {ev.result}
                  </Badge>
                </Table.Cell>
                <Table.Cell>{ev.who}</Table.Cell>
                <Table.Cell>
                  <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)' }}>{ev.mac}</span>
                </Table.Cell>
                <Table.Cell>
                  <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 10.5, color: 'var(--nd-text-secondary)' }}>
                    {ev.method}
                  </span>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/auth-events')}>
          View full auth events →
        </Button>
      </div>
    </div>
  );
}

function EndpointTableRow({ row, onOpenAuth }: { row: EndpointRow; onOpenAuth: () => void }) {
  return (
    <Table.Row>
      <Table.Cell>
        <Badge tone={statusTone(row.status)} dot>
          {row.status}
        </Badge>
      </Table.Cell>
      <Table.Cell>
        <button
          type="button"
          onClick={onOpenAuth}
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
          {row.mac}
        </button>
      </Table.Cell>
      <Table.Cell>{row.hostname ?? '—'}</Table.Cell>
      <Table.Cell>
        <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)', color: 'var(--nd-text-muted)' }}>
          {row.ip ?? '—'}
        </span>
      </Table.Cell>
      <Table.Cell>{row.category ?? '—'}</Table.Cell>
      <Table.Cell>{[row.family, row.os].filter(Boolean).join(' · ') || '—'}</Table.Cell>
      <Table.Cell>{row.profile ?? '—'}</Table.Cell>
      <Table.Cell>
        <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-10)', color: 'var(--nd-text-muted)' }}>
          {row.updatedAt ?? '—'}
        </span>
      </Table.Cell>
    </Table.Row>
  );
}
