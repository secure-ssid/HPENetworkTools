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
 * up as a live sync). Header **LIVE** stamps pure live and sites blend feeds
 * alike (Loop 169). Devices multi-select raises **Export selected**, **Copy
 * serials** (unique newline-joined inventory serials — Devices **Copy serials**
 * pattern; Loop 174), **Copy names** (unique newline-joined device names when
 * serials are sparse — Devices / Topology pattern; Loop 225), **Copy selection
 * link** (`?names=` of marked device names — Devices `?names=` pattern;
 * clearable chip while active; Loop 181), and Clear. Selection-empty `?names=`
 * offers **Clear selection filter** (Loop 208). Header `KeyboardShortcuts`
 * surfaces the devices (and rogue) grid map (Loop 199). Its header actions are
 * derived, never hardcoded: "Open in
 * <plane>" only when a plane claimed the site, "Local terminal" only when a
 * switch-like device row names a target — an AP is not silently promoted to a
 * terminal target — and, on the authored branch, only while the profile still
 * names a core (it is blanked when the operator hid that fixture device, and a
 * headless button would open a device page that no longer exists).
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  PageSkeleton,
  Alert,
  Badge,
  Button,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  Divider,
  EmptyState,
  KeyboardShortcuts,
  Progress,
  SectionHeader, Stat,
  useToast,
  type DataTableColumn,
} from '../nightdesk';
import { getSiteDetail, type SiteDetailData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import type { Density } from '../app/SettingsContext';
import { deviceDetailPath, namesFilterForParam } from '../app/nav';
import { countOf, hhmmLocal as hhmm, SITE_CHAIN, buildSiteTopology, detailState, planeKeyOf } from '@hpe/shared';
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
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { SiteRogueAps } from './siteDetail/RogueAps';
import { SiteSle } from './siteDetail/Sle';
import { SiteApplications } from './siteDetail/Applications';

/** Server CSV path for this site's device inventory (`site=` matches id or name). */
export function siteDevicesExportPath(siteKey: string): string {
  const key = siteKey.trim();
  if (!key) return '/api/devices/export';
  return `/api/devices/export?site=${encodeURIComponent(key)}`;
}

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
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /sites/:id?names=a\nb (bulk Copy selection link). */
  const namesFilter = namesFilterForParam(searchParams.get('names'));
  const namesFilterLc =
    namesFilter === null
      ? null
      : namesFilter.map((name) => name.trim().toLowerCase()).filter(Boolean);
  const rows =
    namesFilterLc === null
      ? devices
      : devices.filter((d) => namesFilterLc.includes((d.name ?? '').trim().toLowerCase()));
  const namesPresent =
    namesFilterLc === null
      ? 0
      : namesFilterLc.filter((name) =>
          devices.some((d) => (d.name ?? '').trim().toLowerCase() === name),
        ).length;
  const rowKeyOf = (d: SiteDeviceRow) => `${d.name}:${d.serial ?? d.plane}`;
  const columns: Array<DataTableColumn<SiteDeviceRow>> = [
    {
      key: 'name',
      title: 'Device',
      hideable: false,
      sortValue: (d) => d.name,
      render: (d) => (
        <button
          type="button"
          onClick={() => onOpen(d)}
          className="nt-mono-link nt-body-sm nt-ta-left"
        >
          {d.name}
        </button>
      ),
    },
    {
      key: 'model',
      title: 'Model',
      sortValue: (d) => d.model,
      render: (d) => d.model,
    },
    {
      key: 'plane',
      title: 'Managed by',
      sortValue: (d) => d.plane,
      render: (d) => (showPlatformTags ? <Badge plane>{d.plane}</Badge> : null),
    },
    {
      key: 'role',
      title: 'Role',
      sortValue: (d) => d.role,
      render: (d) => d.role,
    },
    {
      key: 'state',
      title: 'State',
      sortValue: (d) => d.state,
      render: (d) => (
        <Badge tone={d.stateTone} dot>
          {d.state}
        </Badge>
      ),
    },
    {
      key: 'uptime',
      title: 'Uptime',
      numeric: true,
      sortValue: (d) => d.uptime,
      render: (d) => d.uptime,
    },
  ];

  return (
    <div className="nt-stack nt-gap-10 nt-min-w-0">
      <SectionHeader
        label="Devices at this site"
        meta={
          namesFilterLc !== null
            ? `${countOf(rows.length, 'DEVICE').toUpperCase()} OF ${devices.length} · MIXED PLANES`
            : 'MIXED PLANES'
        }
      />
      {devices.length === 0 ? (
        <div className="nt-hint-muted">no device claimed this site in the last pull</div>
      ) : (
        <>
          {namesFilterLc !== null ? (
            <div className="nt-chip-row" role="group" aria-label="Selection deep link">
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('names');
                  setSearchParams(next, { replace: true });
                  setSelectedKeys([]);
                }}
                title={namesFilter?.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {namesPresent === namesFilterLc.length
                  ? `${namesFilterLc.length} selected device${namesFilterLc.length === 1 ? '' : 's'}`
                  : `${namesPresent} of ${namesFilterLc.length} selected devices present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          {rows.length === 0 ? (
            <div className="nt-stack nt-gap-8">
              <div className="nt-hint-muted">
                No devices match the selection deep link — clear the selection filter to restore the
                site roster.
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('names');
                    setSearchParams(next, { replace: true });
                    setSelectedKeys([]);
                  }}
                >
                  Clear selection filter
                </Button>
              </div>
            </div>
          ) : (
            <DataTable
              ariaLabel="Devices at this site"
              density={density}
              columns={columns}
              rows={rows}
              rowKey={rowKeyOf}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
              onRowActivate={onOpen}
              rowTone={(d) => d.stateTone}
            />
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Site device selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy serials/names, or share a selection link for only the devices you marked — full list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((d) => selected.has(rowKeyOf(d)));
                    if (picked.length === 0) {
                      toast('No selected devices still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'site-devices-selected.csv',
                      ['name', 'model', 'plane', 'role', 'state', 'uptime', 'serial'],
                      picked.map((d) => [
                        d.name,
                        d.model,
                        d.plane,
                        d.role,
                        d.state,
                        d.uptime,
                        d.serial ?? '',
                      ]),
                    );
                    toast(`Exported ${n} selected device${n === 1 ? '' : 's'}`, {
                      description: 'site-devices-selected.csv — site inventory fields only.',
                      tone: 'success',
                    });
                  }}
                >
                  Export selected
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((d) => selected.has(rowKeyOf(d)));
                      if (picked.length === 0) {
                        toast('No selected devices still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const serials = [
                        ...new Set(
                          picked
                            .map((d) => (d.serial ?? '').trim())
                            .filter((serial) => serial && serial !== '—'),
                        ),
                      ];
                      if (serials.length === 0) {
                        toast('No serials on the selected devices', {
                          description: 'Those rows did not publish a serial — use Copy names or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = serials.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(
                          `Copied ${serials.length} serial${serials.length === 1 ? '' : 's'}`,
                          {
                            description:
                              serials.length < picked.length
                                ? `${picked.length - serials.length} selected without a serial skipped`
                                : 'newline-joined · paste into a ticket or RMA',
                            tone: 'success',
                          },
                        );
                      } catch {
                        toast('Could not copy serials', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy serials
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((d) => selected.has(rowKeyOf(d)));
                      if (picked.length === 0) {
                        toast('No selected devices still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const names = [
                        ...new Set(
                          picked
                            .map((d) => (d.name ?? '').trim())
                            .filter((name) => name && name !== '—'),
                        ),
                      ];
                      if (names.length === 0) {
                        toast('No names on the selected devices', {
                          description: 'Those rows did not publish a name — export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = names.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(names.length, 'name')}`, {
                          description:
                            names.length < picked.length
                              ? `${picked.length - names.length} selected without a name skipped`
                              : 'newline-joined · paste into a ticket or change window',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy names', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy names
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((d) => selected.has(rowKeyOf(d)));
                      if (picked.length === 0) {
                        toast('No selected devices still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const names = [
                        ...new Set(
                          picked
                            .map((d) => (d.name ?? '').trim())
                            .filter((name) => name && name !== '—'),
                        ),
                      ];
                      if (names.length === 0) {
                        toast('No names on the selected devices', {
                          description: 'Those rows did not publish a name — export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('names', names.join('\n'));
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${names.length} device${names.length === 1 ? '' : 's'} · names=`,
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy link', { description: url, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy selection link
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                  Clear
                </Button>
              </span>
            </div>
          ) : null}
        </>
      )}
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
      <div className="nt-stack nt-gap-12 nt-pad-2-0-4">
        <div
          className="nt-row-between"
        >
          <span className="nt-body-sm">SSH collector</span>
          <Badge tone={collectorTone} dot>
            {collector}
          </Badge>
        </div>
        {reachValue === null ? (
          <div
            className="nt-row-between"
          >
            <span className="nd-micro-label nt-micro-label">Devices answering directly</span>
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

/** Rows for site open/silenced alerts CSV (summary fields only). */
export function siteOpenAlertsExportRows(
  alerts: readonly SiteAlertRow[],
  silenced: readonly SilencedSiteAlertRow[] = [],
): Array<Array<string>> {
  const open = alerts.map((a) => [a.sev, a.tone, a.title, a.meta, 'open', '', '']);
  const hush = silenced.map((a) => [
    a.sev,
    a.tone,
    a.title,
    a.meta,
    'silenced',
    a.reason ?? '',
    a.until ?? '',
  ]);
  return [...open, ...hush];
}

/** "Open here" (README §7) — the site's open alerts, from whichever source
 *  answered, with the jump-out to the filtered queue. A firing an active
 *  silence benched leaves the active list for the site's own SILENCED (N)
 *  group below it — reason and expiry attached, the same moved-never-hidden
 *  story the Alerts screen tells, so the silence-aware 'clear' badge and this
 *  section never disagree. Silence management itself stays on the Alerts
 *  screen; the "All alerts →" meta is the hand-off.
 *  Export CSV + Copy section link keep the site alerts slice shareable. */
function OpenHereList({
  alerts,
  silenced = [],
  onAllAlerts,
  siteName,
}: {
  alerts: SiteAlertRow[];
  silenced?: SilencedSiteAlertRow[];
  onAllAlerts: () => void;
  siteName?: string;
}) {
  const { toast } = useToast();

  const copySectionLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('section', 'alerts');
    url.hash = 'alerts';
    const href = url.toString();
    void navigator.clipboard.writeText(href).then(
      () =>
        toast('Alerts section link copied', {
          description: 'section=alerts',
          tone: 'success',
        }),
      () => toast('Could not copy link', { description: href, tone: 'warning' }),
    );
  };

  const exportAlerts = () => {
    const safe =
      (siteName ?? 'site')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'site';
    const rows = siteOpenAlertsExportRows(alerts, silenced);
    const n = exportTableCsv(
      `site-alerts-${safe}.csv`,
      ['sev', 'tone', 'title', 'meta', 'state', 'silenceReason', 'silenceUntil'],
      rows,
    );
    toast(`Exported ${n} alert row${n === 1 ? '' : 's'}`, {
      description: 'Open + silenced summary — no payloads.',
      tone: 'success',
    });
  };

  const canExport = alerts.length > 0 || silenced.length > 0;

  return (
    <div className="nt-stack nt-gap-2">
      <div className="nt-filter-bar nt-gap-8">
        <SectionHeader
          label="Open here"
          meta={
            <button type="button" className="nd-link nt-text-link" onClick={onAllAlerts}>
              All alerts →
            </button>
          }
        />
        <Button variant="ghost" size="sm" className="nt-ml-auto" onClick={copySectionLink}>
          Copy section link
        </Button>
        {canExport ? (
          <Button variant="ghost" size="sm" onClick={exportAlerts}>
            Export alerts
          </Button>
        ) : null}
      </div>
      {alerts.map((a) => (
        <div
          key={a.title}
          className="nt-row-start nt-gap-10 nt-rule-row nt-pad-10-0"
        >
          <Badge tone={a.tone} dot>
            {a.sev}
          </Badge>
          <div className="nt-flex-1">
            <div
              className="nt-text-pri-12"
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
          <ul className="nt-lh-15 nt-list-tight">
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
            className="nt-site-fact-grid"
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

/** In-page sections operators can deep-link with `?section=` or `#…`. */
const SITE_SECTIONS = [
  'topology',
  'floorplan',
  'rogues',
  'applications',
  'devices',
  'sle',
  'facts',
  'reachability',
  'alerts',
] as const;
type SiteSection = (typeof SITE_SECTIONS)[number];

function parseSiteSection(raw: string | null | undefined): SiteSection | null {
  if (!raw) return null;
  const key = raw.replace(/^#/, '').trim().toLowerCase();
  return (SITE_SECTIONS as readonly string[]).includes(key) ? (key as SiteSection) : null;
}

function siteViewUrl(section: SiteSection | null): string {
  const url = new URL(window.location.href);
  if (section) {
    url.searchParams.set('section', section);
    url.hash = section;
  } else {
    url.searchParams.delete('section');
    url.hash = '';
  }
  return url.toString();
}

export default function SiteDetail() {
  const navigate = useNavigate();
  const { density, showPlatformTags, pollIntervalSec } = useSettings();
  const { toast } = useToast();
  const { siteId: param = '' } = useParams();
  const [searchParams] = useSearchParams();
  const sectionParam =
    parseSiteSection(searchParams.get('section')) ??
    parseSiteSection(typeof window !== 'undefined' ? window.location.hash : null);
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

  /* Deep-link scroll: `?section=` / `#section` lands on the matching panel once
     the detail body is painted. Unknown section keys are ignored. */
  useEffect(() => {
    if (!detail || detail.apiError || !sectionParam) return;
    const id = window.setTimeout(() => {
      document.getElementById(`site-section-${sectionParam}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 50);
    return () => window.clearTimeout(id);
  }, [detail, sectionParam]);

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
      <div className="nt-stack nt-recon-reveal nt-site-detail-shell nt-section-panel">
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
      <div className="nt-stack nt-recon-reveal nt-site-detail-shell nt-section-panel">
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
              <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
                HPE Network Tools · site
              </span>
              <ProvenanceNote label={source} />
              {/* LIVE on pure live and sites blend alike — provenance mono stamp alone is easy to miss. */}
              {detail.dataSource === 'live' || (detail.blended?.includes('sites') ?? false) ? (
                <Badge tone="info">LIVE</Badge>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => navigate('/sites')}>
                ← All sites
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const url = siteViewUrl(sectionParam);
                    try {
                      await navigator.clipboard.writeText(url);
                      toast('View link copied', {
                        description: sectionParam ? `section=${sectionParam}` : name,
                        tone: 'success',
                      });
                    } catch {
                      toast('Could not copy link', { description: url, tone: 'warning' });
                    }
                  })();
                }}
              >
                Copy view link
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
              {detail.dataSource === 'live' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const siteKey = String(site.id || site.name || param).trim();
                      const path = siteDevicesExportPath(siteKey);
                      const res = await downloadApiCsv(path, 'devices.csv');
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: `devices.csv — site=${siteKey} portal inventory.`,
                          tone: 'success',
                        });
                      } else {
                        toast('Server CSV failed', {
                          description: res.error ?? 'Could not download export',
                          tone: 'warning',
                        });
                      }
                    })();
                  }}
                >
                  Download server CSV
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
              {/* Devices / rogues tables are keyboard grids — surface the map (Loop 199). */}
              <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
            </>
          }
        />
      <div className="nt-plane-theater" role="note">HPE Network Tools · site detail · topology · estate slice</div>
        <div
          className="nt-status-ribbon"
          role="status"
          aria-label="Site status ribbon"
          data-state={site.tone === 'bad' ? 'danger' : site.tone === 'warn' ? 'warning' : undefined}
        >
          <span
            className={`nt-status-ribbon__item${
              site.tone === 'bad'
                ? ' nt-status-ribbon__item--danger'
                : site.tone === 'warn'
                  ? ' nt-status-ribbon__item--warn'
                  : ''
            }`}
          >
            {`health · ${site.health ?? '—'}`}
          </span>
          <span className="nt-status-ribbon__item">{`devices · ${site.devices}`}</span>
          <span
            className={`nt-status-ribbon__item${
              site.alertTone === 'warning' ? ' nt-status-ribbon__item--warn' : ''
            }`}
          >
            {`alerts · ${site.alerts}`}
          </span>
        </div>

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

        <div id="site-section-topology">
          <LiveTopologyPanel
            topology={liveTopology}
            devices={liveDevices}
            onDevice={(deviceName) => navigate(`/devices/${encodeURIComponent(deviceName)}`)}
          />
        </div>

        <div id="site-section-floorplan">
          <SiteFloorPlan maps={sections.maps} clients={sections.mapClients} mistClaimed={mistClaimed} />
        </div>

        <VisualReferencePanel target={{ kind: 'site', id: String(site.id) }} />
        <ConfigActionPanel targetKind="ssid" plane={mistClaimed ? 'MIST' : centralClaimed ? 'CENTRAL' : undefined} target={{ kind: 'site', id: String(site.id) }} />
        <ConfigRecommendationsPanel site={String(site.name ?? site.id)} />

        <div id="site-section-rogues">
          <SiteRogueAps
            rogues={sections.rogues}
            mistClaimed={mistClaimed}
            siteKey={String(site.id)}
            live={detail.dataSource === 'live' || (detail.blended?.includes('sites') ?? false)}
          />
        </div>

        <div id="site-section-applications">
          <SiteApplications
            centralClaimed={centralClaimed}
            siteKey={String(site.id)}
            live={detail.dataSource === 'live' || (detail.blended?.includes('sites') ?? false)}
          />
        </div>

        {/* Same two columns as the authored branch (README §7): the per-site
            device table on the left, facts / reachability / open alerts on the
            right — the API sends both projections with a live site row. */}
        <div
          className="nt-split-site"
        >
          <div id="site-section-devices">
            <SiteDeviceTable
              devices={liveDevices}
              density={density}
              showPlatformTags={showPlatformTags}
              onOpen={(device) => navigate(deviceDetailPath({ name: device.name, plane: device.plane, serial: device.serial }))}
            />
          </div>

          <div className="nt-stack nt-stack-col nt-gap-26-min">
            <div id="site-section-sle">
              <SiteSle
                sle={sections.sle}
                mistClaimed={mistClaimed}
                siteKey={String(site.id)}
                siteName={name}
              />
            </div>
            <div id="site-section-facts" className="nt-stack nt-gap-2">
              <SectionHeader label="Live site facts" />
              {facts.map((fact) => (
                <div
                  key={fact.k}
                  className="nt-row nt-gap-12 nt-rule-row"
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

            <div id="site-section-reachability">
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
            </div>

            <div id="site-section-alerts">
              <OpenHereList
                alerts={liveAlerts}
                silenced={liveSilenced}
                onAllAlerts={() => navigate('/alerts')}
                siteName={name}
              />
            </div>
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
    <div className="nt-stack nt-recon-reveal nt-site-detail-shell nt-section-panel">
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
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              HPE Network Tools · site
            </span>
            <ProvenanceNote label={source} />
            {/* LIVE on pure live and sites blend alike — provenance mono stamp alone is easy to miss. */}
            {detail.dataSource === 'live' || (detail.blended?.includes('sites') ?? false) ? (
              <Badge tone="info">LIVE</Badge>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => navigate('/sites')}>
              ← All sites
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const url = siteViewUrl(sectionParam);
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('View link copied', {
                      description: sectionParam ? `section=${sectionParam}` : name,
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy link', { description: url, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy view link
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
            {detail.dataSource === 'live' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const siteKey = String(site.id || profile?.siteId || site.name || param).trim();
                    const path = siteDevicesExportPath(siteKey);
                    const res = await downloadApiCsv(path, 'devices.csv');
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description: `devices.csv — site=${siteKey} portal inventory.`,
                        tone: 'success',
                      });
                    } else {
                      toast('Server CSV failed', {
                        description: res.error ?? 'Could not download export',
                        tone: 'warning',
                      });
                    }
                  })();
                }}
              >
                Download server CSV
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
            {/* Devices / rogues tables are keyboard grids — surface the map (Loop 199). */}
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
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
          <div className="nt-plane-theater" role="note">HPE Network Tools · site cinema · health owns hue · monochrome planes</div>
          <div
            className="nt-status-ribbon"
            role="status"
            aria-label="Site status ribbon"
            data-state={profile.healthTone === 'negative' ? 'danger' : undefined}
          >
            <span
              className={`nt-status-ribbon__item${
                profile.healthTone === 'negative' ? ' nt-status-ribbon__item--danger' : ''
              }`}
            >
              {`health · ${profile.health ?? '—'}`}
            </span>
            <span className="nt-status-ribbon__item">{`devices · ${profile.deviceCount}`}</span>
            <span className="nt-status-ribbon__item nt-status-ribbon__item--warn">
              {`alerts · ${profile.alertCount}`}
            </span>
          </div>
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
            <div id="site-section-topology" className="nt-stack nt-gap-10">
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
          ) : (
            <div id="site-section-topology" hidden aria-hidden />
          )}

          <div id="site-section-floorplan">
            <SiteFloorPlan maps={detail.maps} clients={detail.mapClients} mistClaimed={mistClaimed} />
          </div>

          <VisualReferencePanel target={{ kind: 'site', id: String(site.id) }} />
          <ConfigActionPanel targetKind="ssid" plane={mistClaimed ? 'MIST' : centralClaimed ? 'CENTRAL' : undefined} target={{ kind: 'site', id: String(site.id) }} />
          <ConfigRecommendationsPanel site={String(site.name ?? site.id)} />

          <div id="site-section-rogues">
            <SiteRogueAps
              rogues={sections.rogues}
              mistClaimed={mistClaimed}
              siteKey={String(site.id)}
              live={detail.dataSource === 'live' || (detail.blended?.includes('sites') ?? false)}
            />
          </div>

          <div id="site-section-applications">
            <SiteApplications
              centralClaimed={centralClaimed}
              siteKey={String(site.id)}
              live={detail.dataSource === 'live' || (detail.blended?.includes('sites') ?? false)}
            />
          </div>

          <div
            className="nt-split-site"
          >
            {/* ---------------- left column ---------------- */}
            <div id="site-section-devices">
              <SiteDeviceTable
                devices={profile.devices}
                density={density}
                showPlatformTags={showPlatformTags}
                onOpen={(device) => navigate(deviceDetailPath({ name: device.name, plane: device.plane, serial: device.serial }))}
              />
            </div>

            {/* ---------------- right column ---------------- */}
            <div className="nt-stack nt-stack-col nt-gap-26-min">
              <div id="site-section-sle">
                <SiteSle
                  sle={detail.sle}
                  mistClaimed={mistClaimed}
                  siteKey={String(site.id)}
                  siteName={name}
                />
              </div>
              <div id="site-section-facts" className="nt-stack nt-gap-2">
                <SectionHeader label="Site facts" />
                {profile.facts.map((f) => (
                  <div
                    key={f.k}
                    className="nt-row nt-gap-12 nt-rule-row"
                  >
                    <span
                      className="nt-fact-row__k nt-w-96"
                    >
                      {f.k}
                    </span>
                    <span
                      className="nt-flex-1 nt-text-sec nt-fs-13"
                    >
                      {f.v}
                    </span>
                  </div>
                ))}
              </div>

              {/* Same component as the live branch, fed from the authored
                  profile — the two sources can never phrase this panel
                  differently. */}
              <div id="site-section-reachability">
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
              </div>

              <div id="site-section-alerts">
                <OpenHereList
                  alerts={profile.alerts}
                  onAllAlerts={() => navigate('/alerts')}
                  siteName={name}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
