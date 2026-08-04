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
  PageSkeleton,
  Alert,
  Badge,
  Button,
  Divider,
  EmptyState,
  Progress,
  SectionHeader, Stat,
  Table,
  useToast,
} from '../nightdesk';
import { getSiteDetail, type SiteDetailData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import type { Density } from '../app/SettingsContext';
import { deviceDetailPath } from '../app/nav';
import { hhmmLocal as hhmm, SITE_CHAIN, buildSiteTopology, detailState, planeKeyOf } from '@hpe/shared';
import type {
  MistRogueApRow,
  SilencedSiteAlertRow,
  SiteAlertRow,
  SiteDeviceRow,
  SiteReachability,
  SiteTopologyLive,
} from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import {
  SiteTopologyDiagram,
  buildLiveSiteTopology,
  liveTopologyLinkFact,
} from './SiteTopology';
import { SiteFloorPlan } from './siteDetail/FloorPlan';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigActionPanel } from '../components/ConfigActionPanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { exportTableCsv } from '../lib/csv';
import { SiteRogueAps } from './siteDetail/RogueAps';
import { SiteSle } from './siteDetail/Sle';
import { SiteApplications } from './siteDetail/Applications';

/** The per-site sections the live/blend envelope carries alongside the site
 *  row (server: liveSiteSections). Optional on the wire — a server that does
 *  not send them leaves the sections honestly empty rather than blank, and
 *  `reachability` in particular is read structurally so the panel appears the
 *  moment the route derives it, without waiting on a client-type widening. */
type LiveSiteSections = {
  devices?: SiteDeviceRow[];
  alerts?: SiteAlertRow[];
  silencedAlerts?: SilencedSiteAlertRow[];
  reachability?: SiteReachability;
  topology?: SiteTopologyLive | null;
  /** The site's Mist rogue/neighbor report (server: siteMistKeys / the demo
   *  branch's authored MIST_ROGUE_APS). Absent = the route did not say. */
  rogues?: MistRogueApRow[];
};

/** Expiry stamp for a silence: hh:mm when it ends today, else day + time, in
 *  the reader's own clock — the same rule the Alerts screen's bench follows. */
function untilLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? hhmm(iso)
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
      className="nt-mono-label"
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
    <div className="nt-stack" style={{ gap: 10, minWidth: 0 }}>
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
                  className="nt-mono-link" style={{ textAlign: "left", fontSize: "var(--nd-text-12)" }}
                >
                  {d.name}
                </button>
              </Table.Cell>
              <Table.Cell>{d.model}</Table.Cell>
              <Table.Cell>
                {showPlatformTags ? <Badge plane>{d.plane}</Badge> : null}
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
          className="nt-hint-muted"
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
    <div className="nt-stack nt-gap-12">
      <SectionHeader label="Local reachability" />
      <div className="nt-stack" style={{ gap: 12, padding: '2px 0 4px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10 }}
        >
          <span className="nt-body-sm">SSH collector</span>
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
              className="nt-hint-muted"
            >
              —
            </span>
          </div>
        ) : (
          <Progress value={reachValue} label="Devices answering directly" note={`${reachValue}%`} />
        )}
        <div
          className="nt-hint-muted nt-lh-15"
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
 *  answered, with the jump-out to the filtered queue. A firing an active
 *  silence benched leaves the active list for the site's own SILENCED (N)
 *  group below it — reason and expiry attached, the same moved-never-hidden
 *  story the Alerts screen tells, so the silence-aware 'clear' badge and this
 *  section never disagree. Silence management itself stays on the Alerts
 *  screen; the "All alerts →" meta is the hand-off. */
function OpenHereList({
  alerts,
  silenced = [],
  onAllAlerts,
}: {
  alerts: SiteAlertRow[];
  silenced?: SilencedSiteAlertRow[];
  onAllAlerts: () => void;
}) {
  return (
    <div className="nt-stack nt-gap-2">
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
          <div className="nt-flex-1">
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
              className="nt-hint-muted"
            >
              {a.meta}
            </div>
          </div>
        </div>
      ))}
      {alerts.length === 0 ? (
        <div
          className="nt-hint-muted nt-pad-y-10"
        >
          {silenced.length > 0
            ? 'hushed, not quiet — everything firing here is silenced below'
            : 'nothing open here'}
        </div>
      ) : null}
      {silenced.length > 0 ? (
        <div className="nt-panel nt-mt-10">
          <div className="nt-panel__head">
            <span className="nt-panel__title">{`SILENCED (${silenced.length})`}</span>
            <span className="nt-panel__hint">
              still firing — benched until the silence expires, never hidden
            </span>
          </div>
          {silenced.map((a) => (
            <div key={a.title} className="nt-panel__row">
              <Badge tone={a.tone} dot>
                {a.sev}
              </Badge>
              <span className="nt-body-sm">{a.title}</span>
              <span className="nt-mono-label">{`${a.reason} · until ${untilLabel(a.until)}`}</span>
            </div>
          ))}
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
      <div className="nt-stack nt-gap-10">
        <SectionHeader
          label="Topology"
          meta={failed ? 'READ FAILED' : empty ? 'EMPTY' : 'NOT REPORTED'}
        />
        <div
          className="nt-hint-muted nt-lh-16"
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
  const omissions = diagram.omissions ?? [];
  // "12 NODES · 8 LINKS" over a diagram that is missing some of them reads as
  // an inventory of the picture. Say the picture is short before the counts
  // are taken for the whole graph.
  const drawn = omissions.length > 0 ? 'PARTIAL · ' : '';
  const sourceMeta = topology?.source.cached
    ? `${drawn}${nodes.length} NODES · ${links.length} LINKS · CACHED`
    : `${drawn}${nodes.length} NODES · ${links.length} LINKS · ${plane ?? 'LIVE'}`;
  const names = new Map(nodes.map((node) => [node.serial, node.name]));

  return (
    <div className="nt-stack nt-gap-12">
      <SectionHeader label="Topology" meta={sourceMeta} />
      {omissions.length > 0 ? (
        <Alert tone="warning" title="This diagram is not the whole graph the plane reported">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>
            {omissions.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <SiteTopologyDiagram topology={diagram} onDevice={onDevice} />
      <div
        className="nt-hint-muted nt-lh-15"
      >
        {diagram.note}
        {topology?.source.cached && readAt ? ` Cached read from ${readAt}.` : ''}
        {linkState === 'failed'
          ? ` Link details failed${topology?.source.note ? ` — ${topology.source.note}` : ''}.`
          : ''}
      </div>
      <div className="nt-stack nt-gap-2">
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
            <span className="nt-text-sec">
              {names.get(link.from) ?? link.from} ↔ {names.get(link.to) ?? link.to}
            </span>
            <span
              className="nt-hint-muted"
            >
              {liveTopologyLinkFact(link) || 'ports and speed not reported'}
            </span>
          </div>
        ))}
        {links.length === 0 ? (
          <div
            className="nt-hint-muted nt-pad-y-8"
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
  const { density, showPlatformTags, pollIntervalSec } = useSettings();
  const { toast } = useToast();
  const { siteId: param = '' } = useParams();
  const [detail, setDetail] = useState<SiteDetailData | null>(null); // null = loading

  /* Navigating site-to-site keeps this screen mounted: the previous site's
     detail is dropped during render (the spinner is honest — nothing about
     the new site is known yet), then the effect reads it. */
  const [prevParam, setPrevParam] = useState(param);
  if (prevParam !== param) {
    setPrevParam(param);
    setDetail(null);
  }

  /* The header stamps LIVE · SYNCED hh:mm, so a NOC tab must not sit on a
     mount-time snapshot under it: poll on the settings cadence, the same
     pattern Overview.tsx runs. One fetch at a time — a slow response never
     stacks up behind the interval. No drawer, form or edit state lives on
     this screen (its buttons only navigate or toast), so a refresh landing
     mid-interaction cannot disturb anything the operator is entering. */
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = () => {
      if (inFlight) return;
      inFlight = true;
      void getSiteDetail(param)
        .then((d) => {
          if (live) setDetail(d);
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
  }, [param, pollIntervalSec]);

  if (detail === null) {
    return <PageSkeleton variant="detail" />;
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
      <div className="nt-stack">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/sites')}>
            ← All sites
          </Button>
        </div>
        <EmptyState
          title="Site not found"
          description={`No fixture or linked plane has reported '${param}'. It may be unmanaged, or the plane that owns it is not linked.`}
        >
          <div className="nt-mt-16">
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
    // Firings an active silence benched out of "Open here" — listed under the
    // section's own SILENCED (N) group with their reason, never dropped.
    const liveSilenced = sections.silencedAlerts ?? [];
    // Derived server-side from the local collector's registry state plus the
    // LOCAL-claimed share of this site's devices. Absent = the route does not
    // compute it, and the panel stays the honest NOT REPORTED note below.
    const reachability = sections.reachability ?? null;
    const liveTopology = sections.topology;
    // Floor plans and SLE are Mist-published; which honest empty sentence
    // those sections show depends on whether a Mist badge claims this site.
    const mistClaimed = site.planes.some((p) => p.name.toUpperCase().includes('MIST'));
    // DPI application visibility is Central-published — same claim rule.
    const centralClaimed = site.planes.some((p) => planeKeyOf(p.name) === 'central');
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
      <div className="nt-stack">
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
              {liveDevices.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const n = exportTableCsv(
                      `site-devices-${name}.csv`,
                      ['name', 'model', 'plane', 'role', 'state', 'uptime', 'serial'],
                      liveDevices.map((d) => [
                        d.name,
                        d.model,
                        d.plane,
                        d.role,
                        d.state,
                        d.uptime,
                        d.serial ?? '',
                      ]),
                    );
                    toast(`Exported ${n} device${n === 1 ? '' : 's'}`, {
                      description: 'Site inventory rows currently loaded.',
                    });
                  }}
                >
                  Export devices
                </Button>
              ) : null}
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

        <SiteFloorPlan maps={sections.maps} clients={sections.mapClients} mistClaimed={mistClaimed} />

        <VisualReferencePanel target={{ kind: 'site', id: String(site.id) }} />
        <ConfigActionPanel targetKind="ssid" plane={mistClaimed ? 'MIST' : centralClaimed ? 'CENTRAL' : undefined} target={{ kind: 'site', id: String(site.id) }} />
        <ConfigRecommendationsPanel site={String(site.name ?? site.id)} />

        <SiteRogueAps rogues={sections.rogues} mistClaimed={mistClaimed} />

        <SiteApplications centralClaimed={centralClaimed} siteKey={String(site.id)} />

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

          <div className="nt-stack" style={{ gap: 26, minWidth: 0 }}>
            <SiteSle
              sle={sections.sle}
              mistClaimed={mistClaimed}
              siteKey={String(site.id)}
              siteName={name}
            />
            <div className="nt-stack nt-gap-2">
              <SectionHeader label="Live site facts" />
              {facts.map((fact) => (
                <div
                  key={fact.k}
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '9px 0',
                    borderBottom: '1px solid var(--nd-border-subtle)' }}
                >
                  <span
                    className="nt-mono-label nt-w-100"
                  >
                    {fact.k}
                  </span>
                  <span className="nt-text-sec">{fact.v}</span>
                </div>
              ))}
            </div>

            {reachability ? (
              <LocalReachabilityPanel
                reachability={reachability}
                onTerminal={(target) => navigate(`/devices/${encodeURIComponent(target)}`)}
              />
            ) : (
              <div className="nt-stack nt-gap-10">
                <SectionHeader label="Local reachability" meta="NOT REPORTED" />
                <div
                  className="nt-hint-muted nt-lh-16"
                >
                  No linked local collector reported reachability for this site.
                </div>
              </div>
            )}

            <OpenHereList
              alerts={liveAlerts}
              silenced={liveSilenced}
              onAllAlerts={() => navigate('/alerts')}
            />
          </div>
        </div>
      </div>
    );
  }

  const topology = profile
    ? buildSiteTopology(profile.siteId, profile.devices, (profile.siteId && SITE_CHAIN[profile.siteId]) || null)
    : null;
  // Same Mist-published sections as the live branch, fed from the route's demo
  // keys — one derivation, so the two branches can never word them differently.
  const mistClaimed = site.planes.some((p) => p.name.toUpperCase().includes('MIST'));
  // Same Central-published section too — one claim rule in both branches.
  const centralClaimed = site.planes.some((p) => planeKeyOf(p.name) === 'central');

  return (
    <div className="nt-stack">
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
            {profile && profile.devices.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const n = exportTableCsv(
                    `site-devices-${name}.csv`,
                    ['name', 'model', 'plane', 'role', 'state', 'uptime', 'serial'],
                    profile.devices.map((d) => [
                      d.name,
                      d.model,
                      d.plane,
                      d.role,
                      d.state,
                      d.uptime,
                      d.serial ?? '',
                    ]),
                  );
                  toast(`Exported ${n} device${n === 1 ? '' : 's'}`, {
                    description: 'Site inventory rows currently loaded.',
                  });
                }}
              >
                Export devices
              </Button>
            ) : null}
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
          <div className="nt-mt-16">
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
            <div className="nt-stack nt-gap-10">
              <SectionHeader label="Topology" meta="RECORDED UPLINKS" />
              <SiteTopologyDiagram
                topology={topology}
                onDevice={(n) => navigate(`/devices/${encodeURIComponent(n)}`)}
              />
              <div
                className="nt-hint-muted"
              >
                {topology.note}
              </div>
            </div>
          ) : null}

          <SiteFloorPlan maps={detail.maps} clients={detail.mapClients} mistClaimed={mistClaimed} />

          <VisualReferencePanel target={{ kind: 'site', id: String(site.id) }} />
          <ConfigActionPanel targetKind="ssid" plane={mistClaimed ? 'MIST' : centralClaimed ? 'CENTRAL' : undefined} target={{ kind: 'site', id: String(site.id) }} />
          <ConfigRecommendationsPanel site={String(site.name ?? site.id)} />

          <SiteRogueAps rogues={sections.rogues} mistClaimed={mistClaimed} />

          <SiteApplications centralClaimed={centralClaimed} siteKey={String(site.id)} />

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
            <div className="nt-stack" style={{ gap: 26, minWidth: 0 }}>
              <SiteSle
                sle={detail.sle}
                mistClaimed={mistClaimed}
                siteKey={String(site.id)}
                siteName={name}
              />
              <div className="nt-stack nt-gap-2">
                <SectionHeader label="Site facts" />
                {profile.facts.map((f) => (
                  <div
                    key={f.k}
                    style={{
                      display: 'flex',
                      gap: 12,
                      padding: '9px 0',
                      borderBottom: '1px solid var(--nd-border-subtle)' }}
                  >
                    <span
                      className="nt-fact-row__k nt-w-96"
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
