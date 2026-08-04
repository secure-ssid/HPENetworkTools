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
 * Filters: free-text `q`, status (online/offline/issues/unknown/idle), site,
 * and issue severity (critical/warning/info). All four write back to the URL
 * and ride server list GETs (`?q=&status=&site=&severity=&limit=&cursor=`) so
 * Load more continues the same slice and **Copy filter link** shares a
 * refreshable view. A **Status** chip row (counts over the loaded q+site+
 * severity universe) toggles the same `?status=` as the header Select —
 * click again to clear. A **Severity** chip row (counts over q+site+status —
 * Loop 146) toggles the same `?severity=`. A **Site** chip row (counts over
 * loaded q+status+severity — Loop 151) toggles the same `?site=`. Filtered
 * empties offer **Clear filters**. Selection-empty `?ids=` offers **Clear
 * selection filter** (Loop 210). Header **LIVE** stamps pure live and blend
 * feeds alike. Multi-select raises **Export selected**, **Copy serials**
 * (unique newline-joined published serials for ticket/RMA paste — Devices
 * **Copy serials** pattern; Loop 169), **Copy names** (unique newline-joined
 * sensor names when serials are sparse — Sites / Topology pattern; Loop 226),
 * **Copy selection link** (`?ids=` of marked sensor ids — Sites `?ids=` pattern;
 * clearable chip while active; Loop 175), and **Clear** so operators can hand
 * off only the sensors they marked.
 * Sensors table carries keyboard shortcuts help (`?` / DATATABLE_ROW_SHORTCUTS —
 * Loop 192).
 *
 * Data: getUxi() — live /api/uxi when the server is up, fixtures otherwise
 * (see web/src/api/screens.ts).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  EmptyState,
  Input,
  KeyboardShortcuts,
  PageSkeleton,
  Select,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { getUxi } from '../api/client';
import type { UxiData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { namesFilterForParam } from '../app/nav';
import { countOf, type StatDef, type Tone, type UxiSensorRow } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';

const UXI_PAGE = 100;

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'idle', label: 'Online (idle)' },
  { value: 'issues', label: 'With issues' },
  { value: 'unknown', label: 'Unknown' },
];

const SEVERITY_OPTIONS = [
  { value: 'all', label: 'All severities' },
  { value: 'critical', label: 'Critical issues' },
  { value: 'warning', label: 'Warning issues' },
  { value: 'info', label: 'Info issues' },
];

const STATUS_VALUES = new Set(STATUS_OPTIONS.map((o) => o.value));
const SEVERITY_VALUES = new Set(['critical', 'warning', 'info']);

function statusFilterForParam(raw: string | null): string {
  const v = raw?.trim().toLowerCase() ?? '';
  return STATUS_VALUES.has(v) ? v : 'all';
}

function severityFilterForParam(raw: string | null): string {
  const v = raw?.trim().toLowerCase() ?? '';
  return SEVERITY_VALUES.has(v) ? v : 'all';
}

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

/** Whether a sensor matches a status filter token (same rules as the server). */
function sensorMatchesStatus(sensor: UxiSensorRow, status: string): boolean {
  if (status === 'all' || !status) return true;
  switch (status) {
    case 'online':
      return sensor.isOnline === true;
    case 'offline':
      return sensor.isOnline === false;
    case 'unknown':
      return sensor.isOnline === null;
    case 'issues':
      return sensor.issueCount > 0;
    case 'idle':
      return sensor.isOnline === true && sensor.isTesting === false;
    default:
      return true;
  }
}

const STATUS_CHIP_META: Array<{
  key: string;
  label: string;
  tone: Tone;
}> = [
  { key: 'online', label: 'Online', tone: 'success' },
  { key: 'offline', label: 'Offline', tone: 'danger' },
  { key: 'idle', label: 'Online (idle)', tone: 'info' },
  { key: 'issues', label: 'With issues', tone: 'warning' },
  { key: 'unknown', label: 'Unknown', tone: 'neutral' },
];

const SEVERITY_CHIP_META: Array<{
  key: string;
  label: string;
  tone: Tone;
}> = [
  { key: 'critical', label: 'Critical', tone: 'danger' },
  { key: 'warning', label: 'Warning', tone: 'warning' },
  { key: 'info', label: 'Info', tone: 'info' },
];

function issuesTone(sensor: UxiSensorRow): Tone {
  if (sensor.issues.some((i) => i.severity === 'critical')) return 'danger';
  if (sensor.issues.some((i) => i.severity === 'warning')) return 'warning';
  return 'neutral';
}

function sensorMatchesSeverity(sensor: UxiSensorRow, severity: string): boolean {
  if (severity === 'all' || !severity) return true;
  return sensor.issues.some((i) => String(i.severity ?? '').toLowerCase() === severity);
}

const SEVERITY_TONE: Record<string, Tone> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

export default function Uxi() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { density, pollIntervalSec } = useSettings();
  const [data, setData] = useState<UxiData | null>(null);
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [status, setStatus] = useState(() => statusFilterForParam(searchParams.get('status')));
  const [severity, setSeverity] = useState(() =>
    severityFilterForParam(searchParams.get('severity')),
  );
  const [site, setSite] = useState(() => {
    const s = searchParams.get('site')?.trim();
    return s && s.length > 0 ? s : 'all';
  });

  const sensorsAccRef = useRef<UxiSensorRow[]>([]);
  const nextCursorRef = useRef<string | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  const [hasMore, setHasMore] = useState(false);
  const [pageTotal, setPageTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /* Sites discovered across loaded pages so the Site select stays useful after Load more. */
  const [knownSites, setKnownSites] = useState<string[]>([]);

  /* Keep ?q= / ?status= / ?site= / ?severity= aligned with the filter row.
   * Selection deep-link `ids=` is URL-owned (Copy selection link) and preserved here. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const qTrim = q.trim();
    if (qTrim) next.set('q', qTrim);
    else next.delete('q');
    if (status !== 'all') next.set('status', status);
    else next.delete('status');
    if (site !== 'all') next.set('site', site);
    else next.delete('site');
    if (severity !== 'all') next.set('severity', severity);
    else next.delete('severity');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [q, status, site, severity, searchParams, setSearchParams]);

  const serverQ = q.trim();
  const serverStatus = status !== 'all' ? status : undefined;
  const serverSite = site !== 'all' ? site : undefined;
  const serverSeverity = severity !== 'all' ? severity : undefined;

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = (mode: 'replace' | 'append' = 'replace') => {
      if (mode === 'replace' && inFlight) return;
      if (mode === 'append' && !nextCursorRef.current) return;
      if (mode === 'replace') inFlight = true;
      if (mode === 'append') setLoadingMore(true);
      void getUxi({
        limit: UXI_PAGE,
        ...(serverQ ? { q: serverQ } : {}),
        ...(serverStatus ? { status: serverStatus } : {}),
        ...(serverSite ? { site: serverSite } : {}),
        ...(serverSeverity ? { severity: serverSeverity } : {}),
        ...(mode === 'append' && nextCursorRef.current ? { cursor: nextCursorRef.current } : {}),
      })
        .then((d) => {
          if (!live) return;
          if (mode === 'append') {
            const seen = new Set(sensorsAccRef.current.map((s) => s.id));
            const extra = d.sensors.filter((s) => !seen.has(s.id));
            const merged = [...sensorsAccRef.current, ...extra];
            sensorsAccRef.current = merged;
            setData({ ...d, sensors: merged });
          } else {
            sensorsAccRef.current = d.sensors;
            setData(d);
          }
          nextCursorRef.current = d.page?.nextCursor ?? null;
          setHasMore(Boolean(d.page?.nextCursor));
          setPageTotal(d.page?.total ?? null);
          setKnownSites((prev) => {
            const set = new Set(prev);
            for (const s of d.sensors) {
              const name = s.site?.trim();
              if (name) set.add(name);
            }
            return [...set].sort((a, b) => a.localeCompare(b));
          });
        })
        .finally(() => {
          if (mode === 'replace') inFlight = false;
          if (mode === 'append') setLoadingMore(false);
        });
    };
    loadMoreRef.current = () => pull('append');
    nextCursorRef.current = null;
    sensorsAccRef.current = [];
    pull('replace');
    const every = Math.max(pollIntervalSec, 10) * 1000;
    const id = setInterval(() => pull('replace'), every);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pollIntervalSec, serverQ, serverStatus, serverSite, serverSeverity]);

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  return (
    <UxiView
      data={data}
      navigate={navigate}
      density={density}
      q={q}
      setQ={setQ}
      status={status}
      setStatus={setStatus}
      severity={severity}
      setSeverity={setSeverity}
      site={site}
      setSite={setSite}
      knownSites={knownSites}
      hasMore={hasMore}
      pageTotal={pageTotal}
      loadingMore={loadingMore}
      onLoadMore={() => loadMoreRef.current()}
    />
  );
}

function UxiView({
  data,
  navigate,
  density,
  q,
  setQ,
  status,
  setStatus,
  severity,
  setSeverity,
  site,
  setSite,
  knownSites,
  hasMore,
  pageTotal,
  loadingMore,
  onLoadMore,
}: {
  data: UxiData;
  navigate: ReturnType<typeof useNavigate>;
  density: 'comfortable' | 'compact';
  q: string;
  setQ: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  severity: string;
  setSeverity: (v: string) => void;
  site: string;
  setSite: (v: string) => void;
  knownSites: string[];
  hasMore: boolean;
  pageTotal: number | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const sensors = data.sensors;
  const missingSources = data.missingSources ?? [];
  const [expanded, setExpanded] = useState<string | null>(null);
  /* Keyboard multi-select (x toggles focused row) raises Export selected /
   * Copy serials / Copy selection link. */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /uxi?ids=a\nb (bulk Copy selection link). Read off the URL
   * like Sites ?ids= — must not drift from the address bar. */
  const idsFilter = namesFilterForParam(searchParams.get('ids'));
  const sectionLive =
    data.dataSource === 'live' || (data.blended?.includes('uxi') ?? false);

  const sensorColumns: Array<DataTableColumn<UxiSensorRow>> = [
    {
      key: 'status',
      title: 'Status',
      hideable: false,
      render: (sensor) => (
        <Badge tone={statusTone(sensor)} dot>
          {statusLabel(sensor)}
        </Badge>
      ),
    },
    {
      key: 'name',
      title: 'Name',
      hideable: false,
      render: (sensor) => sensor.name,
    },
    {
      key: 'serial',
      title: 'Serial',
      render: (sensor) => <span className="nt-hint-muted">{sensor.serial ?? '—'}</span>,
    },
    {
      key: 'model',
      title: 'Model',
      render: (sensor) => sensor.model ?? '—',
    },
    {
      key: 'site',
      title: 'Site',
      render: (sensor) => sensor.site ?? '—',
    },
    {
      key: 'issues',
      title: 'Issues',
      render: (sensor) => <Badge tone={issuesTone(sensor)}>{sensor.issueCount}</Badge>,
    },
    {
      key: 'mac',
      title: 'MAC',
      render: (sensor) => (
        <span className="nt-hint-muted">{sensor.wifiMac ?? sensor.ethernetMac ?? '—'}</span>
      ),
    },
  ];

  /* Server already applied q/status/site/severity; keep a cheap client pass so a
   * stale page cannot flash unfiltered rows mid-request. Status chips count over
   * q+site+severity+ids (not status); severity chips over q+site+status+ids (not severity);
   * site chips over q+status+severity+ids (not site) so each row still shows the full
   * mix while its own chip is on. Selection deep-link `ids=` narrows every universe. */
  const matchesQ = (s: UxiSensorRow): boolean => {
    const ql = q.trim().toLowerCase();
    if (!ql) return true;
    return [s.name, s.serial ?? '', s.site ?? '', s.model ?? '']
      .join(' ')
      .toLowerCase()
      .includes(ql);
  };
  const matchesSite = (s: UxiSensorRow): boolean =>
    site === 'all' || String(s.site ?? '').trim() === site;
  const matchesIds = (s: UxiSensorRow): boolean =>
    idsFilter === null || idsFilter.includes(s.id);
  const matchesQAndSite = (s: UxiSensorRow): boolean =>
    matchesQ(s) && matchesSite(s) && matchesIds(s);
  const statusUniverse = sensors.filter(
    (s) => matchesQAndSite(s) && sensorMatchesSeverity(s, severity),
  );
  const severityUniverse = sensors.filter(
    (s) => matchesQAndSite(s) && sensorMatchesStatus(s, status),
  );
  const siteUniverse = sensors.filter(
    (s) =>
      matchesQ(s) &&
      matchesIds(s) &&
      sensorMatchesStatus(s, status) &&
      sensorMatchesSeverity(s, severity),
  );
  const rows = statusUniverse.filter((s) => sensorMatchesStatus(s, status));
  const statusChips = STATUS_CHIP_META.map((m) => ({
    ...m,
    count: statusUniverse.filter((s) => sensorMatchesStatus(s, m.key)).length,
  })).filter((c) => c.count > 0 || status === c.key);
  const severityChips = SEVERITY_CHIP_META.map((m) => ({
    ...m,
    count: severityUniverse.filter((s) => sensorMatchesSeverity(s, m.key)).length,
  })).filter((c) => c.count > 0 || severity === c.key);
  const siteChipKeys = [
    ...new Set(siteUniverse.map((s) => String(s.site ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (site !== 'all' && !siteChipKeys.includes(site)) siteChipKeys.unshift(site);
  const siteChips = siteChipKeys
    .map((key) => ({
      key,
      label: key,
      count: siteUniverse.filter((s) => String(s.site ?? '').trim() === key).length,
    }))
    .filter((c) => c.count > 0 || site === c.key);

  const idsPresent =
    idsFilter === null ? 0 : idsFilter.filter((id) => sensors.some((s) => s.id === id)).length;
  const filtersActive =
    Boolean(q.trim()) ||
    status !== 'all' ||
    site !== 'all' ||
    severity !== 'all' ||
    idsFilter !== null;
  const clearUxiFilters = () => {
    setQ('');
    setStatus('all');
    setSite('all');
    setSeverity('all');
    if (idsFilter !== null) {
      const next = new URLSearchParams(searchParams);
      next.delete('ids');
      setSearchParams(next, { replace: true });
    }
    setSelectedKeys([]);
  };

  const siteOptions = useMemo(() => {
    const opts = [{ value: 'all', label: 'All sites' }].concat(
      knownSites.map((s) => ({ value: s, label: s })),
    );
    if (site !== 'all' && !opts.some((o) => o.value === site)) {
      opts.push({ value: site, label: `${site} (no sensors)` });
    }
    return opts;
  }, [knownSites, site]);

  const exportSensorsCsv = () => {
    const n = exportTableCsv(
      'uxi-sensors',
      ['id', 'name', 'serial', 'model', 'site', 'isOnline', 'isTesting', 'issueCount', 'wifiMac', 'ethernetMac'],
      rows.map((s) => [
        s.id,
        s.name,
        s.serial ?? '',
        s.model ?? '',
        s.site ?? '',
        s.isOnline === null ? '' : s.isOnline ? 'true' : 'false',
        s.isTesting === null ? '' : s.isTesting ? 'true' : 'false',
        s.issueCount,
        s.wifiMac ?? '',
        s.ethernetMac ?? '',
      ]),
    );
    toast(n === 0 ? 'No sensors to export' : `Exported ${countOf(n, 'sensor')} (current view)`, {
      tone: n === 0 ? 'warning' : 'success',
    });
  };

  const stats = useMemo<StatDef[]>(() => {
    const online = sensors.filter((s) => s.isOnline === true).length;
    const offline = sensors.filter((s) => s.isOnline === false).length;
    const withIssues = sensors.filter((s) => s.issueCount > 0).length;
    const pct = sensors.length > 0 ? Math.round((online / sensors.length) * 100) : 0;
    const totalLabel =
      pageTotal != null && pageTotal > sensors.length
        ? `${sensors.length} of ${pageTotal}`
        : String(sensors.length);
    return [
      {
        label: 'Sensors in view',
        value: totalLabel,
        delta: hasMore ? 'Load more available' : 'UXI fleet',
        tone: 'neutral',
      },
      { label: 'Online (loaded)', value: String(online), delta: `${pct}% of loaded`, tone: 'positive' },
      {
        label: 'Offline (loaded)',
        value: String(offline),
        delta: offline > 0 ? 'needs attention' : 'none offline',
        tone: offline > 0 ? 'negative' : 'neutral',
      },
      {
        label: 'With active issues',
        value: String(withIssues),
        delta: withIssues > 0 ? 'synthetic test issues' : 'none active',
        tone: withIssues > 0 ? 'negative' : 'neutral',
      },
    ];
  }, [sensors, pageTotal, hasMore]);

  return (
    <div className="nt-sites-stack nt-recon-reveal nt-uxi-shell nt-section-panel nt-plane-shell">
      <ScreenHeader
        overline="Operate / UXI"
        title="User Experience Insight"
        subtitle="Sensor fleet health and synthetic test issues from HPE Aruba UXI."
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · experience
            </span>
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <div className="nt-filter-field nt-min-w-160">
              <Input
                size="sm"
                mono
                placeholder="name, serial, site…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Filter UXI sensors"
              />
            </div>
            <div className="nt-filter-field nt-filter-field--sm">
              <Select
                options={STATUS_OPTIONS}
                value={status}
                onValueChange={setStatus}
                size="sm"
                aria-label="Sensor status"
              />
            </div>
            <div className="nt-filter-field nt-filter-field--sm">
              <Select
                options={SEVERITY_OPTIONS}
                value={severity}
                onValueChange={setSeverity}
                size="sm"
                aria-label="Issue severity"
              />
            </div>
            <div className="nt-filter-field nt-filter-field--md">
              <Select
                options={siteOptions}
                value={site}
                onValueChange={setSite}
                size="sm"
                aria-label="Sensor site"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const next = new URLSearchParams();
                  if (q.trim()) next.set('q', q.trim());
                  if (status && status !== 'all') next.set('status', status);
                  if (site && site !== 'all') next.set('site', site);
                  if (severity && severity !== 'all') next.set('severity', severity);
                  const qs = next.toString();
                  const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Filter link copied', {
                      description: qs || 'unfiltered UXI sensors',
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy link', { description: url, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy filter link
            </Button>
            <Button variant="secondary" size="sm" onClick={exportSensorsCsv} disabled={rows.length === 0}>
              Export CSV
            </Button>
            {data.dataSource === 'live' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const qs = new URLSearchParams();
                    if (q.trim()) qs.set('q', q.trim());
                    if (status !== 'all') qs.set('status', status);
                    if (site !== 'all') qs.set('site', site);
                    if (severity !== 'all') qs.set('severity', severity);
                    const suffix = qs.toString() ? `?${qs}` : '';
                    const res = await downloadApiCsv(`/api/uxi/export${suffix}`, 'uxi-sensors.csv');
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description: 'uxi-sensors.csv — portal sensor fleet export.',
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
          </>
        }
      />

      <div className="nt-plane-theater" role="note">NightDesk · UXI ECG · sensor fleet · synthetic issues</div>

      <StatRow stats={stats} />

      {statusChips.length > 0 ? (
        <div className="nt-severity-chips nt-chip-row" role="group" aria-label="Sensor status">
          <span className="nt-chip-row__label">Status</span>
          {statusChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setStatus(status === c.key ? 'all' : c.key)}
              className={status === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={status === c.key}
              data-status={c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {severityChips.length > 0 ? (
        <div className="nt-severity-chips nt-chip-row" role="group" aria-label="Sensor issue severity">
          <span className="nt-chip-row__label">Severity</span>
          {severityChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setSeverity(severity === c.key ? 'all' : c.key)}
              className={severity === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={severity === c.key}
              data-severity={c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {siteChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Sensor sites">
          <span className="nt-chip-row__label">Site</span>
          {siteChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setSite(site === c.key ? 'all' : c.key)}
              className={site === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={site === c.key}
              data-site={c.key}
            >
              <Badge tone="neutral">{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <VisualReferencePanel target={{ kind: 'connector', id: 'uxi', plane: 'UXI' }} />
      <ConfigRecommendationsPanel title="UXI sensor recommendations" limit={6} />

      {missingSources.length > 0 ? (
        <Alert tone="warning" title="UXI is linked but contributed no sensor read this cycle">
          <span className="nt-fs-13">
            The last poll did not carry a sensor fleet update from UXI — treat the fleet below as stale,
            not necessarily current.
          </span>
        </Alert>
      ) : null}

      {idsFilter !== null ? (
        <div className="nt-chip-row" role="group" aria-label="Selection deep link">
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('ids');
              setSearchParams(next, { replace: true });
              setSelectedKeys([]);
            }}
            title={idsFilter.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {idsPresent === idsFilter.length
              ? `${idsFilter.length} selected sensor${idsFilter.length === 1 ? '' : 's'}`
              : `${idsPresent} of ${idsFilter.length} selected sensors present`}
            {' — clear'}
          </button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={
            idsFilter !== null
              ? 'No sensors match this selection'
              : filtersActive
                ? 'No sensors match this filter'
                : 'No UXI sensors'
          }
          description={
            idsFilter !== null
              ? 'Clear the selection filter to restore the sensor fleet under the current search / status / site / severity filters.'
              : filtersActive
                ? 'Nothing in the filtered fleet matches. Clear filters to widen the view.'
                : data.dataSource === 'live'
                  ? 'UXI has not returned any sensors yet — check Connected systems.'
                  : 'HPE Aruba UXI is not linked in this workspace.'
          }
        >
          {idsFilter !== null ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('ids');
                setSearchParams(next, { replace: true });
                setSelectedKeys([]);
              }}
            >
              Clear selection filter
            </Button>
          ) : filtersActive ? (
            <Button variant="secondary" size="sm" onClick={clearUxiFilters}>
              Clear filters
            </Button>
          ) : data.dataSource === 'live' ? (
            <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
              Connected systems
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <div className="nt-stack nt-gap-8">
          <div className="nt-hint-muted nt-fs-12">
            {pageTotal != null
              ? `${rows.length} of ${pageTotal} matching sensors loaded`
              : rows.length === sensors.length
                ? countOf(rows.length, 'sensor')
                : `${rows.length} of ${sensors.length} loaded sensors`}
          </div>
          <div className="nt-row-between">
            <span className="nd-micro-label nt-micro-label">Sensor fleet</span>
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </div>
          <DataTable
            ariaLabel="UXI sensors"
            density={density}
            columns={sensorColumns}
            rows={rows}
            rowKey={(s) => s.id}
            onRowActivate={(s) => setExpanded(expanded === s.id ? null : s.id)}
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            rowTone={(s) => issuesTone(s)}
          />
          {selectedKeys.length > 0 ? (
            <div className="nt-configure-bulk-bar nt-bulk-glass" role="region" aria-label="UXI sensor selection actions">
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy serials/names, or share a selection link for the sensors you marked — full list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((s) => selected.has(s.id));
                    if (picked.length === 0) {
                      toast('No selected sensors still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'uxi-sensors-selected.csv',
                      [
                        'id',
                        'name',
                        'serial',
                        'model',
                        'site',
                        'isOnline',
                        'isTesting',
                        'issueCount',
                        'wifiMac',
                        'ethernetMac',
                      ],
                      picked.map((s) => [
                        s.id,
                        s.name,
                        s.serial ?? '',
                        s.model ?? '',
                        s.site ?? '',
                        s.isOnline === null ? '' : s.isOnline ? 'true' : 'false',
                        s.isTesting === null ? '' : s.isTesting ? 'true' : 'false',
                        s.issueCount,
                        s.wifiMac ?? '',
                        s.ethernetMac ?? '',
                      ]),
                    );
                    toast(`Exported ${countOf(n, 'selected sensor')}`, {
                      description: 'uxi-sensors-selected.csv — fleet fields only.',
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
                      const picked = rows.filter((s) => selected.has(s.id));
                      if (picked.length === 0) {
                        toast('No selected sensors still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const seen = new Set<string>();
                      const serials: string[] = [];
                      for (const s of picked) {
                        const serial = (s.serial ?? '').trim();
                        if (!serial || seen.has(serial)) continue;
                        seen.add(serial);
                        serials.push(serial);
                      }
                      if (serials.length === 0) {
                        toast('No serials on the selected sensors', {
                          description: 'Those rows did not publish a serial — use Copy names or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = serials.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(serials.length, 'serial')}`, {
                          description:
                            serials.length < picked.length
                              ? `${picked.length - serials.length} selected without a serial skipped`
                              : 'newline-joined · paste into a ticket or RMA',
                          tone: 'success',
                        });
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
                      const picked = rows.filter((s) => selected.has(s.id));
                      if (picked.length === 0) {
                        toast('No selected sensors still in view', {
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
                        toast('No names on the selected sensors', {
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
                      const picked = rows.filter((s) => selected.has(s.id));
                      if (picked.length === 0) {
                        toast('No selected sensors still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('ids', picked.map((s) => s.id).join('\n'));
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${picked.length} sensor${picked.length === 1 ? '' : 's'} · ids=`,
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
          {hasMore ? (
            <div className="nt-center-pad nt-pad-8-0">
              <Button variant="secondary" size="sm" disabled={loadingMore} onClick={onLoadMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
          {expanded ? (
            (() => {
              const sensor = rows.find((s) => s.id === expanded);
              if (!sensor) return null;
              return (
                <div
                  className="nt-uxi-detail"
                  role="region"
                  aria-label={`Issues for ${sensor.name}`}
                  data-issues={sensor.issues.length}
                  data-tone={issuesTone(sensor)}
                >
                  <div className="nt-uxi-detail__brand" aria-hidden>
                    NightDesk · UXI spine
                  </div>
                  <div className="nt-fs-13-primary nt-pad-bottom-6">{sensor.name}</div>
                  {sensor.issues.length === 0 ? (
                    <div className="nt-uxi-muted-row">No active issues on this sensor.</div>
                  ) : (
                    <div className="nt-stack-6-pad4">
                      {sensor.issues.map((issue, i) => (
                        <div key={`${issue.code}-${i}`} className="nt-row-13">
                          <Badge tone={SEVERITY_TONE[issue.severity] ?? 'neutral'} dot>
                            {issue.severity}
                          </Badge>
                          <span className="nt-mono-11">{issue.code}</span>
                          <span className="nt-hint-muted">{issue.status}</span>
                          {issue.context ? <span className="nt-text-sec">{issue.context}</span> : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()
          ) : (
            <div className="nt-hint-muted nt-fs-12">Select a sensor row to inspect active issues.</div>
          )}
        </div>
      )}
    </div>
  );
}
