/**
 * web/src/screens/Uxi.tsx — the UXI sensor fleet screen.
 *
 * HPE Aruba UXI sensors report their own online/testing status plus any
 * active synthetic-test issues, but there is no historical test-results pull
 * (results leave UXI through push destinations — S3 — only; see
 * server/src/planes/uxi.ts). So this screen works with what the sensor list
 * and status reads already give us: identity, live health, and active
 * issues — not a time series.
 *
 * Data: getUxi() — live /api/uxi when the server is up, fixtures otherwise
 * (see web/src/api/screens.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, EmptyState, Spinner, Table } from '../nightdesk';
import { getUxi } from '../api/client';
import type { UxiData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import type { StatDef, Tone, UxiSensorRow } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';

function statusTone(sensor: UxiSensorRow): Tone {
  if (sensor.isOnline === false) return 'danger';
  if (sensor.isOnline === null) return 'neutral';
  if (sensor.isTesting === false) return 'info';
  return 'success';
}

function statusLabel(sensor: UxiSensorRow): string {
  if (sensor.isOnline === false) return 'Offline';
  if (sensor.isOnline === null) return 'Unknown';
  if (sensor.isTesting === false) return 'Online (idle)';
  return 'Online';
}

function issuesTone(sensor: UxiSensorRow): Tone {
  if (sensor.issues.some((i) => i.severity === 'critical')) return 'danger';
  if (sensor.issues.some((i) => i.severity === 'warning')) return 'warning';
  return 'neutral';
}

const SEVERITY_TONE: Record<string, Tone> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

export default function Uxi() {
  const navigate = useNavigate();
  const { density } = useSettings();
  const [data, setData] = useState<UxiData | null>(null);

  useEffect(() => {
    let live = true;
    void getUxi().then((d) => {
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

  return <UxiView data={data} navigate={navigate} density={density} />;
}

function UxiView({
  data,
  navigate,
  density,
}: {
  data: UxiData;
  navigate: ReturnType<typeof useNavigate>;
  density: 'comfortable' | 'compact';
}) {
  const sensors = data.sensors;
  const missingSources = data.missingSources ?? [];
  const [expanded, setExpanded] = useState<string | null>(null);

  const stats = useMemo<StatDef[]>(() => {
    const total = sensors.length;
    const online = sensors.filter((s) => s.isOnline === true).length;
    const offline = sensors.filter((s) => s.isOnline === false).length;
    const withIssues = sensors.filter((s) => s.issueCount > 0).length;
    const pct = total > 0 ? Math.round((online / total) * 100) : 0;
    return [
      { label: 'Total sensors', value: String(total), delta: 'UXI fleet', tone: 'neutral' },
      { label: 'Online', value: String(online), delta: `${pct}% of fleet`, tone: 'positive' },
      { label: 'Offline', value: String(offline), delta: offline > 0 ? 'needs attention' : 'none offline', tone: offline > 0 ? 'negative' : 'neutral' },
      {
        label: 'With active issues',
        value: String(withIssues),
        delta: withIssues > 0 ? 'synthetic test issues' : 'none active',
        tone: withIssues > 0 ? 'negative' : 'neutral',
      },
    ];
  }, [sensors]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Operate / UXI"
        title="User Experience Insight"
        subtitle="Sensor fleet health and synthetic test issues from HPE Aruba UXI."
        actions={data.dataSource === 'live' ? <Badge tone="info">LIVE</Badge> : null}
      />

      <StatRow stats={stats} />

      {missingSources.length > 0 ? (
        <Alert tone="warning" title="UXI is linked but contributed no sensor read this cycle">
          <span style={{ fontSize: 13 }}>
            The last poll did not carry a sensor fleet update from UXI — treat the fleet below as stale,
            not necessarily current.
          </span>
        </Alert>
      ) : null}

      {sensors.length === 0 ? (
        <EmptyState
          title="No UXI sensors"
          description={
            data.dataSource === 'live'
              ? 'UXI has not returned any sensors yet — check Connected systems.'
              : 'HPE Aruba UXI is not linked in this workspace.'
          }
        >
          {data.dataSource === 'live' ? (
            <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
              Connected systems
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>Serial</Table.HeaderCell>
              <Table.HeaderCell>Model</Table.HeaderCell>
              <Table.HeaderCell>Site</Table.HeaderCell>
              <Table.HeaderCell>Issues</Table.HeaderCell>
              <Table.HeaderCell>MAC</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {sensors.map((s) => (
              <UxiSensorRows
                key={s.id}
                sensor={s}
                expanded={expanded === s.id}
                onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
              />
            ))}
          </Table.Body>
        </Table>
      )}
    </div>
  );
}

function UxiSensorRows({
  sensor,
  expanded,
  onToggle,
}: {
  sensor: UxiSensorRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const mac = sensor.wifiMac ?? sensor.ethernetMac;
  return (
    <>
      <Table.Row onClick={onToggle}>
        <Table.Cell>
          <Badge tone={statusTone(sensor)} dot>
            {statusLabel(sensor)}
          </Badge>
        </Table.Cell>
        <Table.Cell>{sensor.name}</Table.Cell>
        <Table.Cell>
          <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)', color: 'var(--nd-text-muted)' }}>
            {sensor.serial ?? '—'}
          </span>
        </Table.Cell>
        <Table.Cell>{sensor.model ?? '—'}</Table.Cell>
        <Table.Cell>{sensor.site ?? '—'}</Table.Cell>
        <Table.Cell>
          <Badge tone={issuesTone(sensor)}>{sensor.issueCount}</Badge>
        </Table.Cell>
        <Table.Cell>
          <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)', color: 'var(--nd-text-muted)' }}>
            {mac ?? '—'}
          </span>
        </Table.Cell>
      </Table.Row>
      {expanded ? (
        <Table.Row>
          <Table.Cell colSpan={7}>
            {sensor.issues.length === 0 ? (
              <div style={{ padding: '4px 0', fontSize: 13, color: 'var(--nd-text-muted)' }}>
                No active issues on this sensor.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
                {sensor.issues.map((issue, i) => (
                  <div key={`${issue.code}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                    <Badge tone={SEVERITY_TONE[issue.severity] ?? 'neutral'} dot>
                      {issue.severity}
                    </Badge>
                    <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)' }}>{issue.code}</span>
                    <span style={{ color: 'var(--nd-text-muted)' }}>{issue.status}</span>
                    {issue.context ? <span style={{ color: 'var(--nd-text-secondary)' }}>{issue.context}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </Table.Cell>
        </Table.Row>
      ) : null}
    </>
  );
}
