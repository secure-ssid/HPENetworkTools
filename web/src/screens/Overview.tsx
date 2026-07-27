/**
 * web/src/screens/Overview.tsx — single pane of glass.
 * High-fidelity port of design/NtOverview.dc.html: 5-Stat row → flair divider →
 * two columns (1.5fr / 1fr). Left: "Needs you now" alert rows + Sites table
 * with the 64×3px health bar. Right: Management planes, Launchpad, Change log.
 * Data: getOverview() — live /api/overview when the server is up, shared
 * fixtures otherwise (header then shows the demo SYNCED stamp).
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Divider, SectionHeader, Spinner, Stat, Table } from '../nightdesk';
import { getOverview } from '../api/client';
import type { OverviewData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { pathForView } from '../app/nav';
import type { LaunchpadRow, SiteHealthTone } from '../../../shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import '../app/app.css';

const HEALTH_COLORS: Record<SiteHealthTone, string> = {
  ok: 'var(--nd-success)',
  warn: 'var(--nd-warning)',
  bad: 'var(--nd-danger)',
  stale: 'var(--nd-border-strong)',
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function Overview() {
  const navigate = useNavigate();
  const { density, showPlatformTags, workspaceName, pollIntervalSec } = useSettings();
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    let live = true;
    void getOverview().then((d) => {
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

  const synced =
    data.dataSource === 'demo'
      ? `SYNCED 09:41 · AUTO ${pollIntervalSec}s`
      : `SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : '—'} · AUTO ${pollIntervalSec}s`;

  const runLaunch = (l: LaunchpadRow) => {
    if (l.target.type === 'device') {
      navigate(`/devices/${encodeURIComponent(l.target.device)}`);
    } else {
      navigate(pathForView(l.target.view));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <ScreenHeader
        overline={`${workspaceName} / Single pane`}
        title="Operations"
        subtitle="Ten sites, six management planes — one queue of things that actually need you."
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
            <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
              Connected systems
            </Button>
          </>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: 18,
        }}
      >
        {data.stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} deltaTone={s.tone} />
        ))}
      </div>

      <Divider variant="flair" />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)',
          gap: 34,
          alignItems: 'start',
        }}
      >
        {/* ---------------- left column ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SectionHeader
              label="Needs you now"
              meta={
                <button type="button" className="nd-link" onClick={() => navigate('/alerts')}>
                  All 7 alerts →
                </button>
              }
            />
            {data.alerts.slice(0, 4).map((a) => (
              <div
                key={a.title}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 14,
                  padding: '13px 0',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                }}
              >
                <div style={{ width: 34, flex: '0 0 34px', paddingTop: 1 }}>
                  <Badge tone={a.tone} dot>
                    {a.sev}
                  </Badge>
                </div>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      fontSize: 'var(--nd-text-14)',
                      color: 'var(--nd-text-primary)',
                      lineHeight: 1.35,
                    }}
                  >
                    {a.title}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-11)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {a.meta}
                    </span>
                    {showPlatformTags ? <Badge tone="neutral">{a.plane}</Badge> : null}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-11)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {a.age}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`/devices/${encodeURIComponent(a.device)}`)}
                  >
                    Inspect
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionHeader
              label="Sites"
              meta={
                <button type="button" className="nd-link" onClick={() => navigate('/sites')}>
                  All 10 sites →
                </button>
              }
            />
            <Table density={density}>
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell>Site</Table.HeaderCell>
                  <Table.HeaderCell>Managed by</Table.HeaderCell>
                  <Table.HeaderCell numeric>Devices</Table.HeaderCell>
                  <Table.HeaderCell numeric>Clients</Table.HeaderCell>
                  <Table.HeaderCell>Health</Table.HeaderCell>
                  <Table.HeaderCell>Alerts</Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {data.sites.map((s) => (
                  <Table.Row key={s.name}>
                    <Table.Cell>
                      <button
                        type="button"
                        onClick={() => navigate(`/sites/${encodeURIComponent(s.siteId)}`)}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          fontFamily: 'var(--nd-font-body)',
                          fontSize: 'var(--nd-text-12)',
                          color: 'var(--nd-text-primary)',
                          textAlign: 'left',
                        }}
                      >
                        {s.name}
                      </button>
                    </Table.Cell>
                    <Table.Cell>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 'var(--nd-text-11)',
                          color: 'var(--nd-text-secondary)',
                        }}
                      >
                        {s.plane}
                      </span>
                    </Table.Cell>
                    <Table.Cell numeric>{s.devices}</Table.Cell>
                    <Table.Cell numeric>{s.clients}</Table.Cell>
                    <Table.Cell>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {s.healthPct !== '—' ? (
                          <div
                            style={{
                              width: 64,
                              height: 3,
                              background: 'var(--nd-bg-inset)',
                              borderRadius: 99,
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                height: 3,
                                borderRadius: 99,
                                width: s.healthPct,
                                background: HEALTH_COLORS[s.tone],
                              }}
                            />
                          </div>
                        ) : null}
                        <span
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 'var(--nd-text-11)',
                            color: 'var(--nd-text-muted)',
                          }}
                        >
                          {s.health ?? '—'}
                        </span>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge tone={s.alertTone}>{s.alerts}</Badge>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </div>

        {/* ---------------- right column ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SectionHeader label="Management planes" meta="LAST SYNC" />
            {data.planes.map((p) => (
              <div
                key={p.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 0',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>{p.name}</div>
                  <div
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '.08em',
                    }}
                  >
                    {p.scope}
                  </div>
                </div>
                <Badge tone={p.tone} dot>
                  {p.state}
                </Badge>
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-text-secondary)',
                    width: 52,
                    textAlign: 'right',
                  }}
                >
                  {p.sync}
                </span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionHeader label="Launchpad" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {data.launchpad.map((l) => (
                <button
                  key={l.label}
                  type="button"
                  className="nt-rowlink"
                  onClick={() => runLaunch(l)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    background: 'none',
                    border: 'none',
                    borderBottom: '1px solid var(--nd-border-subtle)',
                    borderLeft: '2px solid transparent',
                    padding: '10px 8px',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--nd-text-primary)' }}>
                    {l.label}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '.08em',
                    }}
                  >
                    {l.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionHeader label="Change log" />
            {data.changes.map((c) => (
              <div
                key={c.time + c.text}
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
                    fontSize: 'var(--nd-text-10)',
                    color: 'var(--nd-text-muted)',
                    width: 46,
                    flex: '0 0 46px',
                    paddingTop: 2,
                  }}
                >
                  {c.time}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 'var(--nd-text-12)',
                      color: 'var(--nd-text-secondary)',
                      lineHeight: 1.4,
                    }}
                  >
                    {c.text}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {c.who}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
