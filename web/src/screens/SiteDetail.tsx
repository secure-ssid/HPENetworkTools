/**
 * web/src/screens/SiteDetail.tsx — one site, however it is managed.
 * High-fidelity port of design/NtSiteDetail.dc.html: header actions (← All
 * sites / Open in <plane> / Local terminal), five Stats, flair divider, then
 * two columns (1.6fr / 1fr): left "Devices at this site" (MIXED PLANES) open
 * table; right Site facts, Local reachability (collector Badge + "Devices
 * answering directly" Progress + terminal button) and "Open here" alerts.
 * The :siteId param is a canonical SiteId, an authored name variant, or a
 * live site id/name. The API is the source of truth: getSiteDetail() always
 * asks /api/sites/:param — the demo branch serves fixture profiles for
 * canonical ids, live/blend rows come back with profile: null, and unknown
 * params 404. profile: null renders an honest EmptyState with a hand-off to
 * Connected systems, and a 404 renders a not-found state — never the
 * authored local-only fallback for a site the portal does not actually know.
 * A live/blend row carries the same per-site sections a profile does —
 * "Devices at this site", "Open here" and, once the route derives it from the
 * local collector's registry state, "Local reachability" (same component as
 * the demo branch, with a null answering share rendering '—' rather than 0%)
 * — so they render from whichever source answered, and the header states
 * which source that was and how fresh it is (demo fixtures are never dressed
 * up as a live sync). Its header
 * actions are derived, never hardcoded: "Open in <plane>" only when a plane
 * claimed the site, "Local terminal" only when a switch-like device row names
 * a target — an AP is not silently promoted to a terminal target — and, on the
 * authored branch, only while the profile still names a core (it is blanked
 * when the operator hid that fixture device, and a headless button would open
 * a device page that no longer exists).
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Divider,
  EmptyState,
  Progress,
  SectionHeader,
  Spinner,
  Stat,
  Table,
  useToast,
} from '../nightdesk';
import { getSiteDetail, type SiteDetailData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import type { Density } from '../app/SettingsContext';
import { deviceDetailPath } from '../app/nav';
import { SITE_CHAIN, buildSiteTopology, detailState } from '../../../shared';
import type {
  SiteAlertRow,
  SiteDeviceRow,
  SiteReachability,
  SiteTopologyLive,
} from '../../../shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import {
  SiteTopologyDiagram,
  buildLiveSiteTopology,
  liveTopologyLinkFact,
} from './SiteTopology';

/** The per-site sections the live/blend envelope carries alongside the site
 *  row (server: liveSiteSections). Optional on the wire — a server that does
 *  not send them leaves the sections honestly empty rather than blank, and
 *  `reachability` in particular is read structurally so the panel appears the
 *  moment the route derives it, without waiting on a client-type widening. */
type LiveSiteSections = {
  devices?: SiteDeviceRow[];
  alerts?: SiteAlertRow[];
  reachability?: SiteReachability;
  topology?: SiteTopologyLive | null;
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Design rule 1: say which source answered and when it last succeeded. Demo
 *  fixtures carry a synthetic syncedAt, so they are labelled, never timed. */
function provenance(detail: SiteDetailData): string {
  const live = detail.dataSource === 'live' || (detail.blended?.includes('sites') ?? false);
  if (!live) return 'DEMO FIXTURE';
  return `LIVE · SYNCED ${detail.syncedAt ? hhmm(detail.syncedAt) : 'NEVER'}`;
}

function ProvenanceNote({ label }: { label: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--nd-font-mono)',
        fontSize: 'var(--nd-text-10)',
        color: 'var(--nd-text-muted)',
        letterSpacing: '.08em',
      }}
    >
      {label}
    </span>
  );
}

/**
 * "Devices at this site" (README §7) — one open table shared by both branches:
 * the authored profile's rows in demo, the reconciled per-site projection the
 * API sends with a live/blend row. Fields a plane does not report arrive as
 * '—' from the server and render as such; nothing is invented here.
 */
function SiteDeviceTable({
  devices,
  density,
  showPlatformTags,
  onOpen,
}: {
  devices: SiteDeviceRow[];
  density: Density;
  showPlatformTags: boolean;
  onOpen: (device: SiteDeviceRow) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <SectionHeader label="Devices at this site" meta="MIXED PLANES" />
      <Table density={density}>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell>Device</Table.HeaderCell>
            <Table.HeaderCell>Model</Table.HeaderCell>
            <Table.HeaderCell>Managed by</Table.HeaderCell>
            <Table.HeaderCell>Role</Table.HeaderCell>
            <Table.HeaderCell>State</Table.HeaderCell>
            <Table.HeaderCell numeric>Uptime</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {devices.map((d) => (
            <Table.Row key={`${d.name}:${d.serial ?? d.plane}`}>
              <Table.Cell>
                <button
                  type="button"
                  onClick={() => onOpen(d)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-12)',
                    color: 'var(--nd-accent-text)',
                    textAlign: 'left',
                  }}
                >
                  {d.name}
                </button>
              </Table.Cell>
              <Table.Cell>{d.model}</Table.Cell>
              <Table.Cell>
                {showPlatformTags ? <Badge tone={d.planeTone}>{d.plane}</Badge> : null}
              </Table.Cell>
              <Table.Cell>{d.role}</Table.Cell>
              <Table.Cell>
                <Badge tone={d.stateTone} dot>
                  {d.state}
                </Badge>
              </Table.Cell>
              <Table.Cell numeric>{d.uptime}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {devices.length === 0 ? (
        <div
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10.5,
            color: 'var(--nd-text-muted)',
          }}
        >
          no device claimed this site in the last pull
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Local reachability" (README §7) — the collector Badge, the "Devices
 * answering directly" Progress and the terminal hand-off, from whichever
 * source answered: the authored profile in demo, the route's derived
 * SiteReachability block in live/blend.
 *
 * `reachValue: null` means the portal does not know the answering share, so
 * the bar is replaced by an honest '—' rather than a 0% Progress, and a
 * missing `core` offers no terminal instead of guessing a target.
 */
function LocalReachabilityPanel({
  reachability,
  onTerminal,
}: {
  reachability: SiteReachability;
  onTerminal: (target: string) => void;
}) {
  const { collector, collectorTone, reachValue, collectorNote, core } = reachability;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHeader label="Local reachability" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 0 4px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>SSH collector</span>
          <Badge tone={collectorTone} dot>
            {collector}
          </Badge>
        </div>
        {reachValue === null ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <span className="nd-micro-label">Devices answering directly</span>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              —
            </span>
          </div>
        ) : (
          <Progress value={reachValue} label="Devices answering directly" note={`${reachValue}%`} />
        )}
        <div
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10.5,
            color: 'var(--nd-text-muted)',
            lineHeight: 1.5,
          }}
        >
          {collectorNote}
        </div>
        {core ? (
          <Button variant="secondary" size="sm" onClick={() => onTerminal(core)}>
            Open terminal on {core}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** "Open here" (README §7) — the site's open alerts, from whichever source
 *  answered, with the jump-out to the filtered queue. */
function OpenHereList({
  alerts,
  onAllAlerts,
}: {
  alerts: SiteAlertRow[];
  onAllAlerts: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader
        label="Open here"
        meta={
          <button type="button" className="nd-link" onClick={onAllAlerts}>
            All alerts →
          </button>
        }
      />
      {alerts.map((a) => (
        <div
          key={a.title}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '10px 0',
            borderBottom: '1px solid var(--nd-border-subtle)',
          }}
        >
          <Badge tone={a.tone} dot>
            {a.sev}
          </Badge>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 'var(--nd-text-12)',
                color: 'var(--nd-text-primary)',
                lineHeight: 1.4,
              }}
            >
              {a.title}
            </div>
            <div
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-10)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {a.meta}
            </div>
          </div>
        </div>
      ))}
      {alerts.length === 0 ? (
        <div
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10.5,
            color: 'var(--nd-text-muted)',
            padding: '10px 0',
          }}
        >
          nothing open here
        </div>
      ) : null}
    </div>
  );
}

function LiveTopologyPanel({
  topology,
  devices,
  onDevice,
}: {
  topology: SiteTopologyLive | null | undefined;
  devices: SiteDeviceRow[];
  onDevice: (name: string) => void;
}) {
  const nodeState = detailState(topology?.source, 'nodes');
  const linkState = detailState(topology?.source, 'links');
  const nodes = topology?.nodes ?? [];
  const links = topology?.links ?? [];
  const hasNodes = nodeState === 'ok' && nodes.length > 0;
  const plane = topology?.source.plane.toUpperCase() ?? null;

  if (!hasNodes) {
    const failed = nodeState === 'failed' || linkState === 'failed';
    const empty = nodeState === 'empty' || linkState === 'empty';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionHeader
          label="Topology"
          meta={failed ? 'READ FAILED' : empty ? 'EMPTY' : 'NOT REPORTED'}
        />
        <div
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-muted)',
            lineHeight: 1.6,
          }}
        >
          {failed
            ? `The topology read did not complete${
                topology?.source.note ? ` — ${topology.source.note}` : ''
              }. No graph is drawn rather than substituting a guessed or demo topology.`
            : empty
              ? `${plane ?? 'The linked plane'} answered for this site and reported no topology nodes or links.`
              : 'No linked source reported a topology for this site. The portal will not substitute the demo site profile.'}
        </div>
      </div>
    );
  }

  const diagram = buildLiveSiteTopology(topology as SiteTopologyLive, devices);
  const readAt = topology?.source.at ? hhmm(topology.source.at) : null;
  const sourceMeta = topology?.source.cached
    ? `${nodes.length} NODES · ${links.length} LINKS · CACHED`
    : `${nodes.length} NODES · ${links.length} LINKS · ${plane ?? 'LIVE'}`;
  const names = new Map(nodes.map((node) => [node.serial, node.name]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHeader label="Topology" meta={sourceMeta} />
      <SiteTopologyDiagram topology={diagram} onDevice={onDevice} />
      <div
        style={{
          fontFamily: 'var(--nd-font-mono)',
          fontSize: 10.5,
          color: 'var(--nd-text-muted)',
          lineHeight: 1.5,
        }}
      >
        {diagram.note}
        {topology?.source.cached && readAt ? ` Cached read from ${readAt}.` : ''}
        {linkState === 'failed'
          ? ` Link details failed${topology?.source.note ? ` — ${topology.source.note}` : ''}.`
          : ''}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SectionHeader label="Reported physical links" meta="PORT-TO-PORT" />
        {links.map((link, index) => (
          <div
            key={`${link.from}:${link.to}:${index}`}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(180px, .8fr) minmax(220px, 1.2fr)',
              gap: 16,
              padding: '8px 0',
              borderBottom: '1px solid var(--nd-border-subtle)',
            }}
          >
            <span style={{ color: 'var(--nd-text-secondary)' }}>
              {names.get(link.from) ?? link.from} ↔ {names.get(link.to) ?? link.to}
            </span>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-10)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {liveTopologyLinkFact(link) || 'ports and speed not reported'}
            </span>
          </div>
        ))}
        {links.length === 0 ? (
          <div
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 10.5,
              color: 'var(--nd-text-muted)',
              padding: '8px 0',
            }}
          >
            {linkState === 'empty'
              ? `${plane ?? 'The linked plane'} reported devices but no physical links.`
              : 'Physical links were not fetched.'}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function SiteDetail() {
  const navigate = useNavigate();
  const { density, showPlatformTags } = useSettings();
  const { toast } = useToast();
  const { siteId: param = '' } = useParams();
  const [detail, setDetail] = useState<SiteDetailData | null>(null); // null = loading

  useEffect(() => {
    let live = true;
    setDetail(null);
    void getSiteDetail(param).then((d) => {
      if (live) setDetail(d);
    });
    return () => {
      live = false;
    };
  }, [param]);

  if (detail === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (detail.apiError) return <ApiErrorState message={detail.apiError} />;

  const { site, profile } = detail;
  const sections = detail as SiteDetailData & LiveSiteSections;
  const source = provenance(detail);

  if (site === null) {
    // Answered 404, or a bookkeeping id ('core-services', 'workspace',
    // 'multiple') that no inventory row backs: without a site row there is
    // nothing to show, and a profile on its own would be a fabricated page.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/sites')}>
            ← All sites
          </Button>
        </div>
        <EmptyState
          title="Site not found"
          description={`No fixture or linked plane has reported '${param}'. It may be unmanaged, or the plane that owns it is not linked.`}
        >
          <div style={{ marginTop: 16 }}>
            <Button variant="primary" size="sm" onClick={() => navigate('/systems')}>
              Connected systems
            </Button>
          </div>
        </EmptyState>
      </div>
    );
  }

  const name = profile ? profile.name : (site?.name ?? param);
  if (!profile && site) {
    const facts = [
      { k: 'Managed by', v: site.planes.map((plane) => plane.name).join(' · ') || 'Not reported' },
      { k: 'Subnet', v: site.subnet === '—' ? 'Not reported' : site.subnet },
      { k: 'Device mix', v: site.mix === '—' ? 'Not reported' : site.mix },
      { k: 'Last sync', v: site.sync === '—' ? 'Not reported' : site.sync },
    ];
    const liveDevices = sections.devices ?? [];
    const liveAlerts = sections.alerts ?? [];
    // Derived server-side from the local collector's registry state plus the
    // LOCAL-claimed share of this site's devices. Absent = the route does not
    // compute it, and the panel stays the honest NOT REPORTED note below.
    const reachability = sections.reachability ?? null;
    const liveTopology = sections.topology;
    const liveTopologyReported =
      detailState(liveTopology?.source, 'nodes') === 'ok' &&
      (liveTopology?.nodes?.length ?? 0) > 0;
    // README §7 header actions. The launch plane is whatever claimed the site —
    // never a hardcoded label, and no button at all when nothing claimed it.
    const launchPlane = site.planes[0]?.name ?? null;
    // "Local terminal" needs a real target. Only a switch-like row is offered;
    // pointing the terminal at the first AP would be a guess, so it is omitted.
    // The route's own LOCAL-claimed target wins when it sends one — it knows
    // which device the collector can actually take a shell on; the name/role
    // heuristic is only the fallback for a payload without reachability.
    const terminalTarget =
      reachability?.core ??
      liveDevices.find((d) => /core/i.test(`${d.role} ${d.name}`))?.name ??
      liveDevices.find((d) => /switch|\bsw\b|sw-/i.test(`${d.role} ${d.name}`))?.name ??
      null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <ScreenHeader
          overline={`Sites / ${name}`}
          title={name}
          subtitle={
            liveTopologyReported
              ? 'Live summary and physical topology from linked plane inventory. The authored site profile is not available.'
              : 'Live summary from linked plane inventory. Topology and local reachability status are shown below.'
          }
          actions={
            <>
              <ProvenanceNote label={source} />
              <Button variant="ghost" size="sm" onClick={() => navigate('/sites')}>
                ← All sites
              </Button>
              {launchPlane ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    toast(`Open in ${launchPlane} — console hand-off queued`, {
                      description: 'Read-only plane: the portal opens its console pre-filled.',
                      tone: 'info',
                    })
                  }
                >
                  Open in {launchPlane}
                </Button>
              ) : null}
              {terminalTarget ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => navigate(`/devices/${encodeURIComponent(terminalTarget)}`)}
                >
                  Local terminal
                </Button>
              ) : null}
            </>
          }
        />

        <div className="nt-stat-grid">
          <Stat label="Devices" value={String(site.devices)} delta="reported inventory rows" deltaTone="neutral" />
          <Stat label="Clients now" value={site.clients} delta={site.clients === '—' ? 'not reported' : 'current rows'} deltaTone="neutral" />
          <Stat
            label="Health"
            value={site.health ?? '—'}
            delta={site.health === null ? 'device state not reported' : 'derived from known device states'}
            deltaTone={site.tone === 'bad' || site.tone === 'warn' ? 'negative' : 'neutral'}
          />
          <Stat
            label="Open alerts"
            value={site.alerts}
            delta={site.alerts === '—' ? 'alert feed not reported' : 'current linked-plane rows'}
            deltaTone={site.alertTone === 'warning' ? 'negative' : 'neutral'}
          />
          {/* README §7 specifies five tiles. No feed reports per-site drift, so
              the tile stays and says why — reusing the live Compliance drift
              stat's own copy (server/src/routes/screens.ts) so the two screens
              cannot disagree — rather than vanishing and silently changing the
              row's shape between demo and live. */}
          <Stat
            label="Config drift"
            value="—"
            delta="no running-config baseline source"
            deltaTone="neutral"
          />
        </div>

        <Divider variant="flair" />

        <LiveTopologyPanel
          topology={liveTopology}
          devices={liveDevices}
          onDevice={(deviceName) => navigate(`/devices/${encodeURIComponent(deviceName)}`)}
        />

        {/* Same two columns as the authored branch (README §7): the per-site
            device table on the left, facts / reachability / open alerts on the
            right — the API sends both projections with a live site row. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)',
            gap: 34,
            alignItems: 'start',
          }}
        >
          <SiteDeviceTable
            devices={liveDevices}
            density={density}
            showPlatformTags={showPlatformTags}
            onOpen={(device) => navigate(deviceDetailPath({ name: device.name, plane: device.plane, serial: device.serial }))}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <SectionHeader label="Live site facts" />
              {facts.map((fact) => (
                <div
                  key={fact.k}
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '9px 0',
                    borderBottom: '1px solid var(--nd-border-subtle)',
                  }}
                >
                  <span
                    style={{
                      width: 100,
                      flex: '0 0 100px',
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10,
                      color: 'var(--nd-text-muted)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {fact.k}
                  </span>
                  <span style={{ color: 'var(--nd-text-secondary)' }}>{fact.v}</span>
                </div>
              ))}
            </div>

            {reachability ? (
              <LocalReachabilityPanel
                reachability={reachability}
                onTerminal={(target) => navigate(`/devices/${encodeURIComponent(target)}`)}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <SectionHeader label="Local reachability" meta="NOT REPORTED" />
                <div
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-text-muted)',
                    lineHeight: 1.6,
                  }}
                >
                  No linked local collector reported reachability for this site.
                </div>
              </div>
            )}

            <OpenHereList alerts={liveAlerts} onAllAlerts={() => navigate('/alerts')} />
          </div>
        </div>
      </div>
    );
  }

  const topology = profile
    ? buildSiteTopology(profile.siteId, profile.devices, (profile.siteId && SITE_CHAIN[profile.siteId]) || null)
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline={`Sites / ${name}`}
        title={name}
        subtitle={
          profile
            ? profile.blurb
            : 'The portal has no linked plane returning a profile for this site.'
        }
        actions={
          <>
            <ProvenanceNote label={source} />
            <Button variant="ghost" size="sm" onClick={() => navigate('/sites')}>
              ← All sites
            </Button>
            {profile ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    toast(`${profile.launch} — console hand-off queued`, {
                      description: 'Read-only plane: the portal opens its console pre-filled.',
                      tone: 'info',
                    })
                  }
                >
                  {profile.launch}
                </Button>
                {/* SiteProfile.core is the empty string when no shell-capable
                    core is known at this site — the route sends that when the
                    authored core is one of the operator's hidden demo devices.
                    A headless "Local terminal" would open a device page that
                    does not exist, so it is not offered at all. */}
                {profile.core ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => navigate(`/devices/${encodeURIComponent(profile.core)}`)}
                  >
                    Local terminal
                  </Button>
                ) : null}
              </>
            ) : null}
          </>
        }
      />

      {profile === null ? (
        <EmptyState
          title="No data — plane not linked"
          description="Live mode returned no profile for this site. Link the plane that manages it, or the local collector, on Connected systems."
        >
          <div style={{ marginTop: 16 }}>
            <Button variant="primary" size="sm" onClick={() => navigate('/systems')}>
              Connect a system
            </Button>
          </div>
        </EmptyState>
      ) : (
        <>
          <div className="nt-stat-grid">
            <Stat
              label="Devices"
              value={profile.deviceCount}
              delta={profile.deviceDelta}
              deltaTone="neutral"
            />
            <Stat
              label="Clients now"
              value={profile.clients}
              delta={profile.clientDelta}
              deltaTone="neutral"
            />
            <Stat
              label="Health"
              value={profile.health ?? '—'}
              delta={profile.healthNote}
              deltaTone={profile.healthTone}
            />
            <Stat
              label="Open alerts"
              value={profile.alertCount}
              delta={profile.alertNote}
              deltaTone="negative"
            />
            <Stat
              label="Config drift"
              value={profile.drift}
              delta={profile.driftNote}
              deltaTone="neutral"
            />
          </div>

          <Divider variant="flair" />

          {topology && topology.nodes.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionHeader label="Topology" meta="RECORDED UPLINKS" />
              <SiteTopologyDiagram
                topology={topology}
                onDevice={(n) => navigate(`/devices/${encodeURIComponent(n)}`)}
              />
              <div
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10.5,
                  color: 'var(--nd-text-muted)',
                }}
              >
                {topology.note}
              </div>
            </div>
          ) : null}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)',
              gap: 34,
              alignItems: 'start',
            }}
          >
            {/* ---------------- left column ---------------- */}
            <SiteDeviceTable
              devices={profile.devices}
              density={density}
              showPlatformTags={showPlatformTags}
              onOpen={(device) => navigate(deviceDetailPath({ name: device.name, plane: device.plane, serial: device.serial }))}
            />

            {/* ---------------- right column ---------------- */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <SectionHeader label="Site facts" />
                {profile.facts.map((f) => (
                  <div
                    key={f.k}
                    style={{
                      display: 'flex',
                      gap: 12,
                      padding: '9px 0',
                      borderBottom: '1px solid var(--nd-border-subtle)',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-10)',
                        letterSpacing: '.1em',
                        textTransform: 'uppercase',
                        color: 'var(--nd-text-muted)',
                        width: 96,
                        flex: '0 0 96px',
                        paddingTop: 2,
                      }}
                    >
                      {f.k}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 13,
                        color: 'var(--nd-text-secondary)',
                      }}
                    >
                      {f.v}
                    </span>
                  </div>
                ))}
              </div>

              {/* Same component as the live branch, fed from the authored
                  profile — the two sources can never phrase this panel
                  differently. */}
              <LocalReachabilityPanel
                reachability={{
                  collector: profile.collector,
                  collectorTone: profile.collectorTone,
                  reachValue: profile.reachValue,
                  collectorNote: profile.collectorNote,
                  core: profile.core,
                }}
                onTerminal={(target) => navigate(`/devices/${encodeURIComponent(target)}`)}
              />

              <OpenHereList alerts={profile.alerts} onAllAlerts={() => navigate('/alerts')} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
