/**
 * web/src/screens/Overview.tsx — single pane of glass.
 * High-fidelity port of design/NtOverview.dc.html: 5-Stat row → flair divider →
 * two columns (1.5fr / 1fr). Left: "Needs you now" alert rows (the site is its
 * own element — and a link — whenever the row carries `siteName`/`siteId`,
 * falling back to the authored `meta` prefix when it does not) + Sites table
 * with the 64×3px health bar and a **Health** chip row (same `?health=` as the
 * Sites Select). Right: Management planes, Launchpad, Change log.
 * A live section that reported nothing keeps its named empty state and drops its
 * "all N →" link rather than pointing at an empty screen.
 * The stat tiles are links (LibreNMS availability-map pattern): each one leads
 * to the screen that lists what it counts — devices to the inventory, alerts
 * to the queue, drift to Compliance, licences to Licences, plane health to
 * Connected systems — so a figure is never a dead end the operator has to
 * re-navigate to.
 * Header **LIVE** stamps pure live (Loop 168 — pure live used to leave the
 * header quiet). Blend mode keeps per-section LIVE/DEMO badges instead.
 * Needs-you-now multi-select (Loop 190) raises **Export selected**, **Copy
 * devices** (unique newline-joined device names), **Copy selection link**
 * (`?devices=`; clearable chip), and **Clear**. Sites preview multi-select
 * raises **Export selected**, **Copy names**, **Copy selection link**
 * (`?siteIds=`; clearable chip), and **Clear**. Header `KeyboardShortcuts`
 * surfaces the alerts/sites grid map (Loop 201).
 * Data: getOverview() — live /api/overview when the server is up, shared
 * fixtures otherwise (header then shows the demo SYNCED stamp).
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  Divider,
  EmptyState,
  KeyboardShortcuts,
  PageSkeleton,
  SectionHeader,
  Select,
  Sparkline,
  useToast,
  type DataTableColumn,
} from '../nightdesk';
import { getMetricsHistory, getOverview, metricsWindowLabel } from '../api/client';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import type { OverviewData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { useIncident } from '../app/IncidentContext';
import { deviceDetailPath, namesFilterForParam, pathForView } from '../app/nav';
import { hhmmLocal as hhmm, countOf, envelopeAnomalies, planeMetricsKey } from '@hpe/shared';
import type {
  LaunchpadRow,
  MetricsHistoryEnvelope,
  OverviewAlert,
  OverviewSiteRow,
  SiteHealthTone,
  SiteId,
} from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import '../app/app.css';
import { StatRow } from './StatRow';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { overviewActionChips } from '../lib/overviewDeltas';

/** Stable row key for Needs-you-now multi-select (plane|device|title). */
export function overviewAlertKey(a: OverviewAlert): string {
  return `${a.plane}|${a.device}|${a.title}`;
}

/** Rows of the Sites preview — the design lists six of the estate. */
const SITES_PREVIEW = 6;

const HEALTH_FILTERS: Array<{ value: 'all' | SiteHealthTone; label: string }> = [
  { value: 'all', label: 'All health' },
  { value: 'ok', label: 'Healthy' },
  { value: 'warn', label: 'Warning' },
  { value: 'bad', label: 'Critical' },
  { value: 'stale', label: 'Unreported' },
];

/** Parse Overview / Sites `?health=` (ok|warn|bad|stale). */
export function parseOverviewHealthFilter(raw: string | null): 'all' | SiteHealthTone {
  if (raw === 'ok' || raw === 'warn' || raw === 'bad' || raw === 'stale') return raw;
  return 'all';
}

/** Build a shareable Overview URL (`health`, bulk `devices=`, bulk `siteIds=`). */
export function buildOverviewShareUrl(opts: {
  health?: 'all' | SiteHealthTone;
  devices?: string[] | null;
  siteIds?: string[] | null;
  origin?: string;
  pathname?: string;
}): string {
  const origin = opts.origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const pathname = opts.pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/overview');
  const next = new URLSearchParams();
  if (opts.health && opts.health !== 'all') next.set('health', opts.health);
  if (opts.devices && opts.devices.length > 0) next.set('devices', opts.devices.join('\n'));
  if (opts.siteIds && opts.siteIds.length > 0) next.set('siteIds', opts.siteIds.join('\n'));
  const qs = next.toString();
  return `${origin}${pathname}${qs ? `?${qs}` : ''}`;
}

/**
 * Where a stat tile leads: the screen whose list the tile's number summarises.
 * Keyed by the label the server and the fixtures both use ('Devices reachable'
 * counts the whole estate, so it opens the unfiltered inventory — a figure
 * must land on the list it actually counts, not on a filtered slice of it).
 * The licences label carries its horizon (`Licences ≤60d`), so it matches on
 * the prefix. A label nobody mapped — a stat this screen has never heard of —
 * stays plain text rather than guessing a destination.
 */
const STAT_LINKS: Record<string, string> = {
  'Devices reachable': '/devices',
  'Open alerts': '/alerts',
  'Config drift': '/compliance',
  'Planes linked': '/systems',
};

function statLinkFor(label: string): string | null {
  if (label.startsWith('Licences')) return '/licenses';
  return STAT_LINKS[label] ?? null;
}

/**
 * The honest comparison window for a plane row's anomaly flags: the full
 * retention when the ring covers it (a demo window always does), what the
 * portal has kept so far while the ring still fills after a server start —
 * the same 95%-of-retention rule metricsWindowLabel words its window by.
 * Module scope keeps the render body pure (the Date.now lives here).
 */
function retainedWindowPhrase(m: MetricsHistoryEnvelope): string {
  const covered =
    m.dataSource === 'demo' ||
    (m.since !== null && Date.now() - Date.parse(m.since) >= m.retentionMs * 0.95);
  return covered ? 'the last 24h this portal retained' : 'what this portal has retained so far';
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

function overviewAlertColumns(opts: {
  showPlatformTags: boolean;
  navigate: (path: string) => void;
  patchIncident: (patch: {
    alertTitle: string;
    deviceName: string;
    devicePlane: OverviewAlert['plane'];
    sourcePath: string;
  }) => void;
}): Array<DataTableColumn<OverviewAlert>> {
  const { showPlatformTags, navigate, patchIncident } = opts;
  const cols: Array<DataTableColumn<OverviewAlert>> = [
    {
      key: 'sev',
      title: 'Sev',
      hideable: false,
      render: (a) => (
        <Badge tone={a.tone} dot>
          {a.sev}
        </Badge>
      ),
    },
    {
      key: 'alert',
      title: 'Alert',
      render: (a) => <span className="nt-fs-12-primary">{a.title}</span>,
    },
    {
      key: 'where',
      title: 'Where',
      render: (a) => {
        const site = siteOf(a);
        return (
          <div className="nt-filter-bar nt-gap-8">
            {site.name !== null ? (
              site.id !== null ? (
                <button
                  type="button"
                  onClick={() => navigate(`/sites/${encodeURIComponent(site.id as SiteId)}`)}
                  className="nt-body-sm nt-link-btn"
                >
                  {site.name}
                </button>
              ) : (
                <span className="nt-fs-11-sec">{site.name}</span>
              )
            ) : null}
            {site.meta ? <span className="nt-hint-muted">{site.meta}</span> : null}
          </div>
        );
      },
    },
  ];
  if (showPlatformTags) {
    cols.push({
      key: 'plane',
      title: 'Plane',
      render: (a) => <Badge plane>{a.plane}</Badge>,
    });
  }
  cols.push(
    {
      key: 'age',
      title: 'Age',
      numeric: true,
      render: (a) => <span className="nt-hint-muted">{a.age}</span>,
    },
    {
      key: 'inspect',
      title: 'Inspect',
      render: (a) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            patchIncident({
              alertTitle: a.title,
              deviceName: a.device,
              devicePlane: a.plane,
              sourcePath: '/overview',
            });
            navigate(deviceDetailPath({ name: a.device, plane: a.plane }));
          }}
        >
          Inspect
        </Button>
      ),
    },
  );
  return cols;
}

function overviewSiteColumns(
  navigate: (path: string) => void,
): Array<DataTableColumn<OverviewSiteRow>> {
  return [
    {
      key: 'site',
      title: 'Site',
      hideable: false,
      render: (s) => (
        <button
          type="button"
          onClick={() => navigate(`/sites/${encodeURIComponent(s.siteId)}`)}
          className="nt-linkish"
        >
          {s.name}
        </button>
      ),
    },
    {
      key: 'plane',
      title: 'Managed by',
      render: (s) => <span className="nt-mono-11 nt-tone-secondary">{s.plane}</span>,
    },
    { key: 'devices', title: 'Devices', numeric: true, render: (s) => s.devices },
    { key: 'clients', title: 'Clients', numeric: true, render: (s) => s.clients },
    {
      key: 'health',
      title: 'Health',
      render: (s) => (
        <div className="nt-row nt-row-center-8">
          {s.healthPct !== '—' ? (
            <div className="nt-health-bar nt-plane-ecg">
              <div
                className={`nt-health-bar__fill nt-health-fill nt-plane-ecg__fill nt-fill-${s.tone}`}
                style={{ ['--nd-health' as string]: s.healthPct }}
              />
            </div>
          ) : null}
          <span className="nt-mono-label">{s.health ?? '—'}</span>
        </div>
      ),
    },
    {
      key: 'alerts',
      title: 'Alerts',
      render: (s) => <Badge tone={s.alertTone}>{s.alerts}</Badge>,
    },
  ];
}

export default function Overview() {
  const { patchIncident } = useIncident();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { density, showPlatformTags, workspaceName, pollIntervalSec } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<OverviewData | null>(null);
  /* Sites preview health filter — same ok/warn/bad/stale vocabulary as Sites
   * (`?health=`). Shareable via Copy view link / refresh. */
  const [health, setHealth] = useState<'all' | SiteHealthTone>(() =>
    parseOverviewHealthFilter(searchParams.get('health')),
  );
  /* Per-plane device-count sparklines ride the metrics-history envelope, not
   * the overview payload; null (older server, unreachable API) simply leaves
   * the rows without a series rather than painting invented history. */
  const [metrics, setMetrics] = useState<MetricsHistoryEnvelope | null>(null);
  /* Needs-you-now + Sites preview multi-select (Loop 190). */
  const [selectedAlertKeys, setSelectedAlertKeys] = useState<string[]>([]);
  const [selectedSiteKeys, setSelectedSiteKeys] = useState<string[]>([]);
  /* Deep link: /overview?devices=a\nb (alerts bulk Copy selection link). */
  const devicesFilter = namesFilterForParam(searchParams.get('devices'));
  /* Deep link: /overview?siteIds=a\nb (sites bulk Copy selection link). */
  const siteIdsFilter = namesFilterForParam(searchParams.get('siteIds'));

  /* Keep ?health= aligned with the Sites preview filter. Preserve bulk deep
   * links (devices=/siteIds=) written by Copy selection link. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (health !== 'all') next.set('health', health);
    else next.delete('health');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [health, searchParams, setSearchParams]);

  /* Re-seed when the address bar changes externally (shared link / back). */
  useEffect(() => {
    const fromUrl = parseOverviewHealthFilter(searchParams.get('health'));
    setHealth((cur) => (cur === fromUrl ? cur : fromUrl));
  }, [searchParams]);

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
      void Promise.all([getOverview(), getMetricsHistory()])
        .then(([d, m]) => {
          if (live) {
            setData(d);
            setMetrics(m);
          }
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
    return <PageSkeleton variant="overview" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  /* Blend mode ships `dataSource: 'demo'` with real rows swapped into the named
   * sections, so the prototype's fixed 09:41 stamp would be asserted over live
   * data. Only a queue with nothing blended keeps the authored stamp. */
  const anyBlended = (data.blended?.length ?? 0) > 0;
  /* Pure-live war room used to leave the header quiet — section LIVE badges
   * only appear in blend mode. Stamp the header when the whole envelope is live. */
  const pureLive = data.dataSource === 'live';
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
  /* A linked plane's device-count series, keyed by the same display label the
   * metrics envelope uses (the demo rows' long names resolve through
   * planeMetricsKey). No series = this plane reports no device inventory, so
   * the row shows nothing rather than a flat invented zero. The envelope's
   * additive anomaly block dots the samples the server flagged as unusual
   * for that series; an older server sends no block, and a series with too
   * few samples has no entry — both render exactly as before, no dots. */
  const planeSpark = (name: string) => {
    if (metrics === null) return null;
    const key = planeMetricsKey(name);
    const series = metrics.planes[key]?.devices ?? [];
    const flags = envelopeAnomalies(metrics)?.planes[key]?.devices ?? [];
    if (series.length >= 2) {
      const latest = series[series.length - 1]!.v;
      return (
        <Sparkline
          points={series}
          width={64}
          height={16}
          label={`${latest} device${latest === 1 ? '' : 's'} reported · ${metricsWindowLabel(metrics)}`}
          markers={flags.length > 0 ? flags : undefined}
        />
      );
    }
    if (series.length === 1) {
      return (
        <span
          className="nt-hint-muted"
        >
          1 sample
        </span>
      );
    }
    return null;
  };
  /* Anomaly markers on the rows above: only when at least one linked plane's
   * device series carries a flag does the panel explain the dots, and the
   * note names the comparison window honestly — the full retention when the
   * ring covers it (a demo window always does), what the portal has kept so
   * far while the ring still fills after a server start (the
   * metricsWindowLabel rule). Statistics over kept samples, never a
   * prediction or an ML claim. */
  const servedAnomalies = metrics !== null ? envelopeAnomalies(metrics) : null;
  const anyPlaneAnomaly =
    servedAnomalies !== null &&
    linkedPlanes.some((p) => (servedAnomalies.planes[planeMetricsKey(p.name)]?.devices?.length ?? 0) > 0);
  const retainedPhrase = metrics !== null ? retainedWindowPhrase(metrics) : 'what this portal has retained so far';
  const actionChips = overviewActionChips(metrics, data.stats);

  /* A count-bearing link has to lead somewhere. A live section that reported
   * nothing gets no link at all — "All 0 alerts →" advertises a queue that is
   * not there, and the named empty state below already says what is true
   * (README §honesty). Demo keeps the authored prose, which always counts. */
  const alertsLink =
    !alertsLive ? 'All 7 alerts →'
    : data.alerts.length > 0 ? `All ${countOf(data.alerts.length, 'alert')} →`
    : null;
  const sitesForHealthBase =
    health === 'all' ? data.sites : data.sites.filter((s) => s.tone === health);
  const sitesForHealth =
    siteIdsFilter === null
      ? sitesForHealthBase
      : sitesForHealthBase.filter((s) => siteIdsFilter.includes(s.siteId));
  const siteIdsPresent =
    siteIdsFilter === null
      ? 0
      : siteIdsFilter.filter((id) => data.sites.some((s) => s.siteId === id)).length;
  const alertsForDevices =
    devicesFilter === null
      ? data.alerts
      : data.alerts.filter((a) => devicesFilter.includes(a.device));
  const devicesPresent =
    devicesFilter === null
      ? 0
      : devicesFilter.filter((d) => data.alerts.some((a) => a.device === d)).length;
  const alertPreview = alertsForDevices.slice(0, 4);
  const sitePreview = sitesForHealth.slice(0, SITES_PREVIEW);
  /* Health chips count over the full sites preview (not health) so operators
   * see the estate mix while a chip is active — same idea as Sites. */
  const HEALTH_CHIP_META: Array<{
    key: SiteHealthTone;
    label: string;
    tone: 'success' | 'warning' | 'danger' | 'neutral';
  }> = [
    { key: 'ok', label: 'Healthy', tone: 'success' },
    { key: 'warn', label: 'Warning', tone: 'warning' },
    { key: 'bad', label: 'Critical', tone: 'danger' },
    { key: 'stale', label: 'Unreported', tone: 'neutral' },
  ];
  const healthChips = HEALTH_CHIP_META.map((m) => ({
    ...m,
    count: data.sites.filter((s) => s.tone === m.key).length,
  })).filter((c) => c.count > 0 || health === c.key);
  const sitesLink =
    !sitesLive
      ? 'All 10 sites →'
      : sitesForHealth.length > 0
        ? health === 'all'
          ? `All ${countOf(data.sites.length, 'site')} →`
          : `${countOf(sitesForHealth.length, 'site')} ${health} →`
        : data.sites.length > 0
          ? null
          : null;
  const openSitesList = () => {
    const qs = health !== 'all' ? `?health=${encodeURIComponent(health)}` : '';
    navigate(`/sites${qs}`);
  };
  const subtitle =
    sitesLive || planesLive
      ? `${countOf(data.sites.length, 'site')}, ${countOf(data.planes.length, 'management plane')} — one queue of things that actually need you.`
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
      <span className="nt-inline-center-8">
        {badge}
        {link !== null ? (
          <button type="button" className="nd-link nt-text-link" onClick={open}>
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
    <div className="nt-stack nt-overview nt-recon-reveal nt-overview-shell nt-section-panel">
      <ScreenHeader
        overline={overline}
        title="Operations"
        subtitle={subtitle}
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · war room
            </span>
            <span className="nt-mono-label">{synced}</span>
            {pureLive ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const url = buildOverviewShareUrl({
                    health,
                    devices: devicesFilter,
                    siteIds: siteIdsFilter,
                  });
                  try {
                    await navigator.clipboard.writeText(url);
                    const bits = [
                      health !== 'all' ? `health=${health}` : null,
                      devicesFilter ? 'devices=' : null,
                      siteIdsFilter ? 'siteIds=' : null,
                    ].filter(Boolean);
                    toast('View link copied', {
                      description: bits.length > 0 ? bits.join(' · ') : 'operations overview',
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const parts: string[] = [];
                if (data.alerts.length > 0) {
                  parts.push(
                    `${exportTableCsv(
                      'overview-alerts.csv',
                      ['sev', 'title', 'plane', 'age', 'device', 'site', 'meta'],
                      data.alerts.map((a) => [
                        a.sev,
                        a.title,
                        a.plane,
                        a.age,
                        a.device,
                        a.siteName ?? '',
                        a.meta,
                      ]),
                    )} alerts`,
                  );
                }
                if (data.sites.length > 0) {
                  parts.push(
                    `${exportTableCsv(
                      'overview-sites.csv',
                      ['name', 'siteId', 'plane', 'devices', 'clients', 'health', 'alerts'],
                      data.sites.map((s) => [
                        s.name,
                        s.siteId,
                        s.plane,
                        s.devices,
                        s.clients,
                        s.health ?? '',
                        s.alerts,
                      ]),
                    )} sites`,
                  );
                }
                if (data.planes.length > 0) {
                  parts.push(
                    `${exportTableCsv(
                      'overview-planes.csv',
                      ['name', 'scope', 'state', 'sync', 'linked'],
                      data.planes.map((p) => [
                        p.name,
                        p.scope,
                        p.state,
                        p.sync,
                        p.linked ? 'yes' : 'no',
                      ]),
                    )} planes`,
                  );
                }
                toast(parts.length ? `Exported ${parts.join(' · ')}` : 'Nothing to export', {
                  description: parts.length
                    ? 'Client-side CSV of the current Overview payload.'
                    : 'Alerts, sites, and planes are empty.',
                });
              }}
            >
              Export CSV
            </Button>
            {data.dataSource === 'live' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    /* Multi-slice server CSV matches client Export (alerts +
                     * planes + sites + changes). Sites honour the active
                     * health filter so the CSV matches the Sites preview. */
                    const slices: Array<{ part: string; file: string; qs?: string }> = [
                      { part: 'alerts', file: 'overview-alerts.csv' },
                      { part: 'planes', file: 'overview-planes.csv' },
                      {
                        part: 'sites',
                        file: 'overview-sites.csv',
                        qs: health !== 'all' ? `health=${encodeURIComponent(health)}` : undefined,
                      },
                      { part: 'changes', file: 'overview-changes.csv' },
                    ];
                    const ok: string[] = [];
                    let fail: string | null = null;
                    for (const s of slices) {
                      const params = new URLSearchParams({ part: s.part });
                      if (s.qs) {
                        const extra = new URLSearchParams(s.qs);
                        extra.forEach((v, k) => params.set(k, v));
                      }
                      const res = await downloadApiCsv(
                        `/api/overview/export?${params.toString()}`,
                        s.file,
                      );
                      if (res.ok) ok.push(s.part);
                      else if (!fail) fail = res.error ?? `Could not download ${s.file}`;
                    }
                    if (ok.length > 0) {
                      toast('Server CSV downloaded', {
                        description: `${ok.join(' · ')}${
                          health !== 'all' && ok.includes('sites') ? ` (sites health=${health})` : ''
                        } — operator facts only, no secrets.`,
                        tone: fail ? 'warning' : 'success',
                      });
                    }
                    if (fail) {
                      toast(ok.length > 0 ? 'Some server CSV slices failed' : 'Server CSV failed', {
                        description: fail,
                        tone: 'warning',
                      });
                    }
                  })();
                }}
              >
                Download server CSV
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
              Connected systems
            </Button>
            {/* Needs-you-now + Sites preview multi-select are keyboard grids (j/k/x/Esc) — surface the map (Loop 201). */}
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </>
        }
      />
      <div className="nt-plane-theater" role="note">NightDesk · war-room spine · planes · freshness · P1 heat</div>

      <StatRow stats={data.stats} linkForStat={statLinkFor} />

      {actionChips.length > 0 ? (
        <div
          className="nt-change-strip"
          role="region"
          aria-label="What needs attention now"
        >
          <span className="nt-change-strip__kicker">
            {actionChips.some((c) => c.id !== 'licences') ? 'Last hour' : 'Attention'}
          </span>
          {actionChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`nt-change-strip__chip nt-change-strip__chip--${chip.tone}`}
              onClick={() => navigate(chip.href)}
            >
              {chip.label}
            </button>
          ))}
          <span className="nt-change-strip__note">
            {actionChips.some((c) => c.id === 'licences') &&
            actionChips.every((c) => c.id === 'licences')
              ? 'from licence inventory · not a prediction'
              : actionChips.some((c) => c.id === 'licences')
                ? 'samples + licence inventory · not a prediction'
                : 'from plane count samples · not a prediction'}
          </span>
        </div>
      ) : null}

      <VisualReferencePanel target={{ kind: 'estate', id: 'overview' }} editable={false} />
      <ConfigRecommendationsPanel title="Top recommendations" limit={5} />

      <Divider variant="flair" />

      <div className="nt-overview__layout">
        {/* ---------------- left column ---------------- */}
        <div className="nt-configure__col nt-recon-reveal">
          <div className="nt-stack nt-gap-10">
            <SectionHeader
              label="Needs you now"
              meta={sectionMeta(alertsLive, alertsLink, () => navigate('/alerts'))}
            />
            {data.alerts.length === 0 ? (
              <EmptyState
                title="Nothing needs you right now"
                description={
                  alertsLive
                    ? 'No open alerts across the linked planes as of the last poll. The Alerts queue still carries history, silences, and rules.'
                    : 'No open alerts in this snapshot. Open the Alerts queue for history, silences, and rules.'
                }
              >
                <Button variant="secondary" size="sm" onClick={() => navigate('/alerts')}>
                  Open Alerts
                </Button>
              </EmptyState>
            ) : alertsForDevices.length === 0 ? (
              <EmptyState
                title="No alerts match this selection"
                description="Clear the devices deep link, or open the full Alerts queue."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('devices');
                    setSearchParams(next, { replace: true });
                  }}
                >
                  Clear selection filter
                </Button>
              </EmptyState>
            ) : (
            /* Titles repeat across devices in live data ('Config Out of Sync'),
               so identity is plane|device|title (Loop 190 multi-select). */
            <>
            {devicesFilter !== null ? (
              <div className="nt-chip-row" role="group" aria-label="Alert selection deep link">
                <button
                  type="button"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('devices');
                    setSearchParams(next, { replace: true });
                  }}
                  title={devicesFilter.join(', ')}
                  className="nt-chip nt-chip--active"
                >
                  {devicesPresent === devicesFilter.length
                    ? `${devicesFilter.length} selected device${devicesFilter.length === 1 ? '' : 's'}`
                    : `${devicesPresent} of ${devicesFilter.length} selected devices present`}
                  {' — clear'}
                </button>
              </div>
            ) : null}
            <DataTable
              ariaLabel="Needs you now"
              density={density}
              columns={overviewAlertColumns({
                showPlatformTags,
                navigate,
                patchIncident,
              })}
              rows={alertPreview}
              rowKey={(a) => overviewAlertKey(a)}
              selectedKeys={selectedAlertKeys}
              onSelectionChange={setSelectedAlertKeys}
              rowTone={(a) => a.tone}
            />
            {selectedAlertKeys.length > 0 ? (
              <div
                className="nt-configure-bulk-bar nt-bulk-glass"
                role="region"
                aria-label="Overview alert selection actions"
              >
                <span className="nt-configure-bulk-bar__count">{`${selectedAlertKeys.length} SELECTED`}</span>
                <span className="nt-configure-bulk-bar__hint">
                  export, copy devices, or share a selection link for only the alerts you marked —
                  full export stays in the header
                </span>
                <span className="nt-configure-bulk-bar__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const selected = new Set(selectedAlertKeys);
                      const picked = alertPreview.filter((a) => selected.has(overviewAlertKey(a)));
                      if (picked.length === 0) {
                        toast('No selected alerts still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const n = exportTableCsv(
                        'overview-alerts-selected.csv',
                        ['sev', 'title', 'plane', 'age', 'device', 'site', 'meta'],
                        picked.map((a) => [
                          a.sev,
                          a.title,
                          a.plane,
                          a.age,
                          a.device,
                          a.siteName ?? '',
                          a.meta,
                        ]),
                      );
                      toast(`Exported ${countOf(n, 'selected alert')}`, {
                        description: 'overview-alerts-selected.csv — filtered fields only.',
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
                        const selected = new Set(selectedAlertKeys);
                        const picked = alertPreview.filter((a) => selected.has(overviewAlertKey(a)));
                        if (picked.length === 0) {
                          toast('No selected alerts still in view', {
                            description: 'Clear selection or adjust filters.',
                            tone: 'info',
                          });
                          return;
                        }
                        const devices = [
                          ...new Set(
                            picked
                              .map((a) => (a.device ?? '').trim())
                              .filter((d) => d && d !== '—'),
                          ),
                        ];
                        if (devices.length === 0) {
                          toast('No devices on the selected alerts', {
                            description: 'Those rows did not publish a device name — export CSV instead.',
                            tone: 'info',
                          });
                          return;
                        }
                        const text = devices.join('\n');
                        try {
                          await navigator.clipboard.writeText(text);
                          toast(`Copied ${countOf(devices.length, 'device')}`, {
                            description:
                              devices.length < picked.length
                                ? `${picked.length - devices.length} selected without a device skipped`
                                : 'newline-joined · paste into a ticket or change window',
                            tone: 'success',
                          });
                        } catch {
                          toast('Could not copy devices', { description: text, tone: 'warning' });
                        }
                      })();
                    }}
                  >
                    Copy devices
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void (async () => {
                        const selected = new Set(selectedAlertKeys);
                        const picked = alertPreview.filter((a) => selected.has(overviewAlertKey(a)));
                        if (picked.length === 0) {
                          toast('No selected alerts still in view', {
                            description: 'Clear selection or adjust filters.',
                            tone: 'info',
                          });
                          return;
                        }
                        const devices = [
                          ...new Set(
                            picked
                              .map((a) => (a.device ?? '').trim())
                              .filter((d) => d && d !== '—'),
                          ),
                        ];
                        if (devices.length === 0) {
                          toast('No devices on the selected alerts', {
                            description: 'Those rows did not publish a device name — export CSV instead.',
                            tone: 'info',
                          });
                          return;
                        }
                        const next = new URLSearchParams(searchParams);
                        next.set('devices', devices.join('\n'));
                        const qs = next.toString();
                        const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                        try {
                          await navigator.clipboard.writeText(url);
                          toast('Selection link copied', {
                            description: `${devices.length} device${devices.length === 1 ? '' : 's'} · devices=`,
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
                  <Button variant="ghost" size="sm" onClick={() => setSelectedAlertKeys([])}>
                    Clear
                  </Button>
                </span>
              </div>
            ) : null}
            </>
            )}
          </div>

          <div className="nt-stack nt-gap-10">
            <div className="nt-row-between-12">
              <SectionHeader
                label="Sites"
                meta={sectionMeta(sitesLive, sitesLink, openSitesList)}
              />
              <Select
                aria-label="Filter sites by health"
                value={health}
                onChange={(e) => setHealth(parseOverviewHealthFilter(e.target.value))}
              >
                {HEALTH_FILTERS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
            {healthChips.length > 0 ? (
              <div className="nt-chip-row" role="group" aria-label="Site health">
                <span className="nt-chip-row__label">Health</span>
                {healthChips.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setHealth(health === c.key ? 'all' : c.key)}
                    className={health === c.key ? 'nt-chip nt-chip--active' : 'nt-chip'}
                    aria-pressed={health === c.key}
                  >
                    <Badge tone={c.tone}>{c.label}</Badge>
                    <span className="nt-chip__count">{c.count}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {data.sites.length === 0 ? (
              <EmptyState
                title="No sites reported yet"
                description={
                  sitesLive
                    ? 'No linked plane has published a site as of the last poll — link or repair a plane under Connected systems.'
                    : 'No linked plane has published a site — link one under Connected systems.'
                }
              >
                <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                  Connected systems
                </Button>
              </EmptyState>
            ) : sitesForHealthBase.length === 0 ? (
              <EmptyState
                title="No sites match this health"
                description="Try another health filter, clear the filter, or open the full Sites list with the same health applied."
              >
                <span className="nt-inline-center-8">
                  {health !== 'all' ? (
                    <Button variant="secondary" size="sm" onClick={() => setHealth('all')}>
                      Clear health filter
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={openSitesList}>
                    Open Sites
                  </Button>
                </span>
              </EmptyState>
            ) : sitesForHealth.length === 0 ? (
              <EmptyState
                title="No sites match this selection"
                description="Clear the siteIds deep link, or open the full Sites list."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('siteIds');
                    setSearchParams(next, { replace: true });
                  }}
                >
                  Clear selection filter
                </Button>
              </EmptyState>
            ) : (
            /* A preview, not the estate — the section link carries the total.
               Multi-select (Loop 190) uses stable siteId keys. */
            <>
            {siteIdsFilter !== null ? (
              <div className="nt-chip-row" role="group" aria-label="Site selection deep link">
                <button
                  type="button"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('siteIds');
                    setSearchParams(next, { replace: true });
                  }}
                  title={siteIdsFilter.join(', ')}
                  className="nt-chip nt-chip--active"
                >
                  {siteIdsPresent === siteIdsFilter.length
                    ? `${siteIdsFilter.length} selected site${siteIdsFilter.length === 1 ? '' : 's'}`
                    : `${siteIdsPresent} of ${siteIdsFilter.length} selected sites present`}
                  {' — clear'}
                </button>
              </div>
            ) : null}
            <DataTable
              ariaLabel="Sites preview"
              density={density}
              columns={overviewSiteColumns(navigate)}
              rows={sitePreview}
              rowKey={(s) => s.siteId}
              selectedKeys={selectedSiteKeys}
              onSelectionChange={setSelectedSiteKeys}
              onRowActivate={(s) => navigate(`/sites/${encodeURIComponent(s.siteId)}`)}
              rowTone={(s) => {
                if (s.alertTone === 'danger' || s.alertTone === 'warning') return s.alertTone;
                if (s.tone === 'bad') return 'danger';
                if (s.tone === 'warn') return 'warning';
                if (s.tone === 'ok') return 'success';
                return 'neutral';
              }}
            />
            {selectedSiteKeys.length > 0 ? (
              <div
                className="nt-configure-bulk-bar nt-bulk-glass"
                role="region"
                aria-label="Overview site selection actions"
              >
                <span className="nt-configure-bulk-bar__count">{`${selectedSiteKeys.length} SELECTED`}</span>
                <span className="nt-configure-bulk-bar__hint">
                  export, copy names, or share a selection link for only the sites you marked — full
                  list export stays in the header
                </span>
                <span className="nt-configure-bulk-bar__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const selected = new Set(selectedSiteKeys);
                      const picked = sitePreview.filter((s) => selected.has(s.siteId));
                      if (picked.length === 0) {
                        toast('No selected sites still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const n = exportTableCsv(
                        'overview-sites-selected.csv',
                        ['name', 'siteId', 'plane', 'devices', 'clients', 'health', 'alerts'],
                        picked.map((s) => [
                          s.name,
                          s.siteId,
                          s.plane,
                          s.devices,
                          s.clients,
                          s.health ?? '',
                          s.alerts,
                        ]),
                      );
                      toast(`Exported ${countOf(n, 'selected site')}`, {
                        description: 'overview-sites-selected.csv — filtered fields only.',
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
                        const selected = new Set(selectedSiteKeys);
                        const picked = sitePreview.filter((s) => selected.has(s.siteId));
                        if (picked.length === 0) {
                          toast('No selected sites still in view', {
                            description: 'Clear selection or adjust filters.',
                            tone: 'info',
                          });
                          return;
                        }
                        const names = [
                          ...new Set(
                            picked
                              .map((s) => (s.name ?? '').trim())
                              .filter((name) => name && name !== '—'),
                          ),
                        ];
                        if (names.length === 0) {
                          toast('No names on the selected sites', {
                            description: 'Those rows did not publish a site name — export CSV for ids instead.',
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
                        const selected = new Set(selectedSiteKeys);
                        const picked = sitePreview.filter((s) => selected.has(s.siteId));
                        if (picked.length === 0) {
                          toast('No selected sites still in view', {
                            description: 'Clear selection or adjust filters.',
                            tone: 'info',
                          });
                          return;
                        }
                        const next = new URLSearchParams(searchParams);
                        next.set('siteIds', picked.map((s) => s.siteId).join('\n'));
                        const qs = next.toString();
                        const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                        try {
                          await navigator.clipboard.writeText(url);
                          toast('Selection link copied', {
                            description: `${picked.length} site${picked.length === 1 ? '' : 's'} · siteIds=`,
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
                  <Button variant="ghost" size="sm" onClick={() => setSelectedSiteKeys([])}>
                    Clear
                  </Button>
                </span>
              </div>
            ) : null}
            </>
            )}
          </div>
        </div>

        {/* ---------------- right column ---------------- */}
        <div className="nt-configure__col">
          <div className="nt-stack nt-gap-2">
            <SectionHeader
              label="Management planes"
              meta={
                <span className="nt-inline-center-8">
                  {sourceBadge(planesLive)}
                  <span>LAST SYNC</span>
                </span>
              }
            />
            {data.planes.length === 0 ? (
              <EmptyState
                title="No management planes linked"
                description={
                  planesLive
                    ? 'The live registry has no linked planes yet — connect one under Connected systems so inventory and alerts can land here.'
                    : 'The portal has nothing to poll until a plane is connected under Connected systems.'
                }
              >
                <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                  Connected systems
                </Button>
              </EmptyState>
            ) : null}
            {linkedPlanes.map((p) => {
              const hot = p.tone === 'danger' || p.tone === 'warning';
              return (
              <div
                key={p.name}
                className={`nt-plane-mini${hot ? ' nt-plane-mini--ecg' : ''}`}
                data-tone={p.tone}
              >
                <div className="nt-plane-mini__id">
                  <span>{p.name}</span>
                  <small>{p.scope}</small>
                </div>
                <Badge tone={p.tone} dot>
                  {p.state}
                </Badge>
                {planeSpark(p.name)}
                <span className="nt-plane-mini__sync">{p.sync}</span>
              </div>
              );
            })}
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
                  <span>{`${countOf(dormantPlanes.length, 'plane')} not linked`}</span>
                  <small>no credentials configured</small>
                </div>
                <span className="nt-plane-mini__sync">Connect ▸</span>
              </button>
            ) : null}
            {/* What the sparklines above actually are, stated once for the
                whole panel — the metric, the window, the cadence, and (in the
                demo envelope) that the history is synthesized. When a row
                carries anomaly dots the note says what they are and what
                window they were judged against; no dots, no note. */}
            {metrics !== null && data.planes.length > 0 ? (
              <div className="nt-filter-bar nt-gap-8 nt-pad-y-6-2">
                <div className="nt-hint-muted">
                  {`devices reported per plane · ${metricsWindowLabel(metrics)}`}
                  {anyPlaneAnomaly ? ` · dots mark samples unusual vs ${retainedPhrase}` : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="nt-ml-auto"
                  onClick={() => {
                    void (async () => {
                      const slices: Array<{ part: string; file: string }> = [
                        { part: 'series', file: 'metrics-series.csv' },
                        { part: 'anomalies', file: 'metrics-anomalies.csv' },
                      ];
                      const ok: string[] = [];
                      let fail: string | null = null;
                      for (const s of slices) {
                        const res = await downloadApiCsv(
                          `/api/metrics/export?part=${encodeURIComponent(s.part)}`,
                          s.file,
                        );
                        if (res.ok) ok.push(s.part);
                        else if (!fail) fail = res.error ?? `Could not download ${s.file}`;
                      }
                      if (ok.length > 0) {
                        toast('Metrics server CSV downloaded', {
                          description: `${ok.join(' · ')} — count samples / anomaly flags only.`,
                          tone: fail ? 'warning' : 'success',
                        });
                      }
                      if (fail) {
                        toast(
                          ok.length > 0 ? 'Some metrics CSV slices failed' : 'Metrics CSV failed',
                          { description: fail, tone: 'warning' },
                        );
                      }
                    })();
                  }}
                >
                  Download metrics CSV
                </Button>
              </div>
            ) : null}
          </div>

          <div className="nt-stack nt-gap-10">
            <SectionHeader label="Launchpad" />
            {data.launchpad.length === 0 ? (
              <EmptyState
                title="No launch targets"
                description="Launchpad rows are built from the linked planes and the devices they report. Connect a plane or open Inventory once estate data is available."
              >
                <span className="nt-inline-center-8">
                  <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                    Connected systems
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => navigate('/inventory')}>
                    Inventory
                  </Button>
                </span>
              </EmptyState>
            ) : null}
            <div className="nt-stack nt-gap-0">
              <div className="nt-launchpad">{data.launchpad.map((l) => (
                <button
                  key={l.label}
                  type="button"
                  className="nt-rowlink nt-launchpad-row nt-launchpad__tile"
                  onClick={() => runLaunch(l)}
                >
                  <span className="nt-launchpad-row__label">
                    {l.label}
                  </span>
                  <span
                    className="nt-mono-label"
                  >
                    {l.hint}
                  </span>
                </button>
              ))}</div>
            </div>
          </div>

          <div className="nt-stack nt-gap-10">
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
                  description={
                    changesLive
                      ? 'Every write the portal makes lands here with its authorising ticket. Review or stage the next change under Configure.'
                      : 'Every write the portal makes lands here with its authorising ticket.'
                  }
                >
                  <Button variant="secondary" size="sm" onClick={() => navigate('/configure')}>
                    Open Configure
                  </Button>
                </EmptyState>
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
                className="nt-changelog-row"
              >
                <span
                  className="nt-sync-row__time"
                >
                  {hhmm(c.time)}
                </span>
                <div className="nt-flex-1">
                  <div
                    className="nt-fs-12-sec-lh"
                  >
                    {c.text}
                  </div>
                  <div
                    className="nt-hint-muted"
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
