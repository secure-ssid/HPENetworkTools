/**
 * web/src/screens/Overview.tsx — single pane of glass.
 * High-fidelity port of design/NtOverview.dc.html: 5-Stat row → flair divider →
 * two columns (1.5fr / 1fr). Left: "Needs you now" alert rows (the site is its
 * own element — and a link — whenever the row carries `siteName`/`siteId`,
 * falling back to the authored `meta` prefix when it does not) + Sites table
 * with the 64×3px health bar. Right: Management planes, Launchpad, Change log.
 * A live section that reported nothing keeps its named empty state and drops its
 * "all N →" link rather than pointing at an empty screen.
 * Data: getOverview() — live /api/overview when the server is up, shared
 * fixtures otherwise (header then shows the demo SYNCED stamp).
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Divider,
  EmptyState,
  SectionHeader,
  Spinner,
  Table,
} from '../nightdesk';
import { getOverview } from '../api/client';
import type { OverviewData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { pathForView } from '../app/nav';
import type { LaunchpadRow, OverviewAlert, SiteHealthTone, SiteId } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import '../app/app.css';
import { StatRow } from './StatRow';

const HEALTH_COLORS: Record<SiteHealthTone, string> = {
  ok: 'var(--nd-success)',
  warn: 'var(--nd-warning)',
  bad: 'var(--nd-danger)',
  stale: 'var(--nd-border-strong)',
};

/** Rows of the Sites preview — the design lists six of the estate. */
const SITES_PREVIEW = 6;

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Where an alert is, and what is left of its meta line once the site has been
 * taken out of it.
 *
 * "Needs you now" has no Site column, so the authored fixtures compose the
 * site into `meta` as a prose prefix. A mapper that has the site as a field
 * sends `siteName` (and `siteId`) instead, and that is preferred: a site is a
 * place the operator can open, not a sentence fragment. The prefix is stripped
 * when a payload carries BOTH, so the site can never be printed twice.
 */
function siteOf(a: OverviewAlert): { name: string | null; id: SiteId | null; meta: string } {
  const name = a.siteName?.trim() ? a.siteName.trim() : null;
  if (name === null) return { name: null, id: null, meta: a.meta };
  const prefix = `${name} · `;
  const meta = a.meta.startsWith(prefix)
    ? a.meta.slice(prefix.length)
    : a.meta.trim() === name
      ? ''
      : a.meta;
  return { name, id: a.siteId ?? null, meta };
}

export default function Overview() {
  const navigate = useNavigate();
  const { density, showPlatformTags, workspaceName, pollIntervalSec } = useSettings();
  const [data, setData] = useState<OverviewData | null>(null);

  /* The header states a cadence ("AUTO 60s") that the server poller really runs
   * at, so the screen has to honour it — a NOC-wall tab left open must not sit
   * on a mount-time snapshot under a badge promising a refresh (design rule 1).
   * One fetch at a time: a slow response never stacks up behind the interval. */
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = () => {
      if (inFlight) return;
      inFlight = true;
      void getOverview()
        .then((d) => {
          if (live) setData(d);
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
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  /* Blend mode ships `dataSource: 'demo'` with real rows swapped into the named
   * sections, so the prototype's fixed 09:41 stamp would be asserted over live
   * data. Only a queue with nothing blended keeps the authored stamp. */
  const anyBlended = (data.blended?.length ?? 0) > 0;
  const synced =
    data.dataSource === 'demo' && !anyBlended
      ? `SYNCED 09:41 · AUTO ${pollIntervalSec}s`
      : `SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : '—'} · AUTO ${pollIntervalSec}s`;

  /* Section links and the subtitle are count-bearing (README §1), so a live or
   * blended section counts the rows it actually carries — which is exactly what
   * the linked screen goes on to render. The prototype's totals ("All 7 alerts",
   * "All 10 sites" of which six are previewed) describe the fixture estate, not
   * the payload, so they stay behind a demo-sourced section. */
  const alertsLive = data.dataSource === 'live' || (data.blended?.includes('alerts') ?? false);
  const sitesLive = data.dataSource === 'live' || (data.blended?.includes('sites') ?? false);
  const planesLive = data.dataSource === 'live' || (data.blended?.includes('planes') ?? false);
  /* The right-hand plane panel lists what actually answers. Planes with no
     credentials all say the same nothing, so they collapse to one line that
     leads to Connected systems rather than filling the column. */
  const linkedPlanes = data.planes.filter((p) => p.linked);
  const dormantPlanes = data.planes.filter((p) => !p.linked);
  /* A count-bearing link has to lead somewhere. A live section that reported
   * nothing gets no link at all — "All 0 alerts →" advertises a queue that is
   * not there, and the named empty state below already says what is true
   * (README §honesty). Demo keeps the authored prose, which always counts. */
  const alertsLink =
    !alertsLive ? 'All 7 alerts →'
    : data.alerts.length > 0 ? `All ${plural(data.alerts.length, 'alert')} →`
    : null;
  const sitesLink =
    !sitesLive ? 'All 10 sites →'
    : data.sites.length > 0 ? `All ${plural(data.sites.length, 'site')} →`
    : null;
  const subtitle =
    sitesLive || planesLive
      ? `${plural(data.sites.length, 'site')}, ${plural(data.planes.length, 'management plane')} — one queue of things that actually need you.`
      : 'Ten sites, six management planes — one queue of things that actually need you.';

  const changesLive = data.dataSource === 'live' || (data.blended?.includes('changes') ?? false);

  /* Blend mode mixes fixture sections and live sections under identical chrome —
   * the envelope names the swapped ones so the UI can say which is which
   * (README §blendLive). Nothing to say when the whole payload is one source. */
  const sourceBadge = (live: boolean) =>
    anyBlended ? <Badge tone={live ? 'info' : 'neutral'}>{live ? 'LIVE' : 'DEMO'}</Badge> : null;

  /* Section chrome: the source badge and the "all N →" link, or nothing at all
   * when a single-source payload has an empty section — an empty meta span
   * would still print the header's separator rule. */
  const sectionMeta = (live: boolean, link: string | null, open: () => void) => {
    const badge = sourceBadge(live);
    if (badge === null && link === null) return undefined;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {badge}
        {link !== null ? (
          <button type="button" className="nd-link" onClick={open}>
            {link}
          </button>
        ) : null}
      </span>
    );
  };

  /* The API computes the workspace for this screen; the settings context is only
   * a localStorage-seeded first-paint stand-in, so the server value wins. */
  const overline = `${data.workspace ?? workspaceName} / Single pane`;

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
        overline={overline}
        title="Operations"
        subtitle={subtitle}
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

      <StatRow stats={data.stats} />

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionHeader
              label="Needs you now"
              meta={sectionMeta(alertsLive, alertsLink, () => navigate('/alerts'))}
            />
            {data.alerts.length === 0 ? (
              <EmptyState
                title="Nothing needs you right now"
                description={
                  alertsLive
                    ? 'No open alerts across the linked planes as of the last poll.'
                    : 'No open alerts across the linked planes.'
                }
              />
            ) : (
            /* Titles repeat across devices in live data ('Config Out of Sync'),
               so identity is the row, not its name. */
            <Table density={density}>
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell>Sev</Table.HeaderCell>
                  <Table.HeaderCell>Alert</Table.HeaderCell>
                  <Table.HeaderCell>Where</Table.HeaderCell>
                  {showPlatformTags ? <Table.HeaderCell>Plane</Table.HeaderCell> : null}
                  <Table.HeaderCell numeric>Age</Table.HeaderCell>
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {data.alerts.slice(0, 4).map((a, i) => {
                  const site = siteOf(a);
                  return (
                    <Table.Row key={`${a.plane}|${a.device}|${a.title}|${i}`}>
                      <Table.Cell>
                        <Badge tone={a.tone} dot>
                          {a.sev}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
                          {a.title}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        {/* The site as its own element when the row carries it —
                            openable when it also carries the canonical id, plain
                            text when the payload only named it. */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {site.name !== null ? (
                            site.id !== null ? (
                              <button
                                type="button"
                                onClick={() => navigate(`/sites/${encodeURIComponent(site.id as SiteId)}`)}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: 0,
                                  cursor: 'pointer',
                                  fontFamily: 'var(--nd-font-body)',
                                  fontSize: 'var(--nd-text-11)',
                                  color: 'var(--nd-accent-text)',
                                  textAlign: 'left',
                                }}
                              >
                                {site.name}
                              </button>
                            ) : (
                              <span style={{ fontSize: 'var(--nd-text-11)', color: 'var(--nd-text-secondary)' }}>
                                {site.name}
                              </span>
                            )
                          ) : null}
                          {site.meta ? (
                            <span
                              style={{
                                fontFamily: 'var(--nd-font-mono)',
                                fontSize: 'var(--nd-text-11)',
                                color: 'var(--nd-text-muted)',
                              }}
                            >
                              {site.meta}
                            </span>
                          ) : null}
                        </div>
                      </Table.Cell>
                      {showPlatformTags ? (
                        <Table.Cell>
                          <Badge tone="neutral">{a.plane}</Badge>
                        </Table.Cell>
                      ) : null}
                      <Table.Cell numeric>
                        <span
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 'var(--nd-text-11)',
                            color: 'var(--nd-text-muted)',
                          }}
                        >
                          {a.age}
                        </span>
                      </Table.Cell>
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
                  );
                })}
              </Table.Body>
            </Table>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionHeader
              label="Sites"
              meta={sectionMeta(sitesLive, sitesLink, () => navigate('/sites'))}
            />
            {data.sites.length === 0 ? (
              <EmptyState
                title="No sites reported yet"
                description="No linked plane has published a site — link one under Connected systems."
              >
                <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                  Connected systems
                </Button>
              </EmptyState>
            ) : (
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
                {/* A preview, not the estate — the section link carries the total. */}
                {data.sites.slice(0, SITES_PREVIEW).map((s) => (
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
            )}
          </div>
        </div>

        {/* ---------------- right column ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SectionHeader
              label="Management planes"
              meta={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {sourceBadge(planesLive)}
                  <span>LAST SYNC</span>
                </span>
              }
            />
            {data.planes.length === 0 ? (
              <EmptyState
                title="No management planes linked"
                description="The portal has nothing to poll until a plane is connected."
              >
                <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                  Connected systems
                </Button>
              </EmptyState>
            ) : null}
            {linkedPlanes.map((p) => (
              <div key={p.name} className="nt-plane-mini">
                <div className="nt-plane-mini__id">
                  <span>{p.name}</span>
                  <small>{p.scope}</small>
                </div>
                <Badge tone={p.tone} dot>
                  {p.state}
                </Badge>
                <span className="nt-plane-mini__sync">{p.sync}</span>
              </div>
            ))}
            {/* The planes that were never given credentials say the same thing
                as each other and nothing about the estate, so they collapse to
                one line rather than filling the panel. */}
            {dormantPlanes.length > 0 ? (
              <button
                type="button"
                className="nt-plane-mini nt-plane-mini--more"
                onClick={() => navigate('/systems')}
              >
                <div className="nt-plane-mini__id">
                  <span>{`${dormantPlanes.length} plane${dormantPlanes.length === 1 ? '' : 's'} not linked`}</span>
                  <small>no credentials configured</small>
                </div>
                <span className="nt-plane-mini__sync">Connect ▸</span>
              </button>
            ) : null}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionHeader label="Launchpad" />
            {data.launchpad.length === 0 ? (
              <EmptyState
                title="No launch targets"
                description="Launchpad rows are built from the linked planes and the devices they report."
              />
            ) : null}
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
            <SectionHeader label="Change log" meta={sourceBadge(changesLive)} />
            {/* The change log is the write broker's audit tail — empty until the
                first brokered change, which is a fact, not a failure. It stops
                being a fact the moment a rotated generation cannot be opened:
                the record exists and is unreachable, which is the opposite
                claim to "nothing has happened here". */}
            {data.changes.length === 0 ? (
              (data.changesUnreadable ?? 0) > 0 ? (
                <EmptyState
                  title="Part of the change record could not be read"
                  description={`${data.changesUnreadable} rotated log generation${
                    data.changesUnreadable === 1 ? '' : 's'
                  } could not be opened, so this is not a record of nothing happening. Check the portal's data directory.`}
                />
              ) : (
                <EmptyState
                  title="No brokered changes yet"
                  description="Every write the portal makes lands here with its authorising ticket."
                />
              )
            ) : (data.changesUnreadable ?? 0) > 0 ? (
              // A non-empty tail with a hole behind it: the rows shown are
              // real, but they are not the whole history.
              <Alert
                tone="warning"
                title={`${data.changesUnreadable} rotated log generation${
                  data.changesUnreadable === 1 ? '' : 's'
                } could not be read — this tail is short`}
              />
            ) : null}
            {/* ChangeLogEntry is {time,text,who} — the broker's audit rows lose
                their changeId/ticket in this projection, so two brokered writes
                of the same kind in the same minute collide on time+text (live:
                two "alert-ack alert — validated" rows at 19:33). Identity is the
                position in the tail the server sent, not the prose. */}
            {data.changes.map((c, i) => (
              <div
                key={`${c.time}|${c.text}|${c.who}|${i}`}
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
