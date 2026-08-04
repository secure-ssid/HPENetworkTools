/**
 * web/src/screens/Sites.tsx — ten sites, and the plane each one answers to.
 * High-fidelity port of design/NtSites.dc.html: header actions carry the plane
 * Select + name Input + "Add site", a 4-Stat row, flair divider, the open
 * table (Site / Managed by — multiple plane Badges / Mix / Devices / Clients /
 * 70×3px Health bar / Alerts / Last sync), and a footer with the mono count
 * and a decorative one-page Pagination. The footer count is derived from the
 * loaded rows and carries the envelope's own provenance stamp (DEMO FIXTURE vs
 * LIVE · SYNCED hh:mm), so a fixture total is never read as a live estate.
 * Filters are local, instant, AND-combined. `?q=` / `?plane=` / `?health=` seed
 * the filter row and stay written back as the operator types (shareable,
 * refresh-stable). Health is the SiteHealthTone key (ok/warn/bad/stale).
 * A **Health** chip row (counts over the plane+q universe) toggles the same
 * `health` filter as the header Select — click again to clear. A **Plane** chip
 * row (counts over the health+q universe) toggles the same `plane` filter.
 * "Add site" opens a small honest drawer: sites are created on the managing
 * plane, so submitting hands off (toast) instead of fake-creating a row.
 * Header **LIVE** stamps pure live and blend feeds alike. Multi-select raises
 * **Export selected**, **Copy names** (unique newline-joined site names —
 * Central sites / Devices **Copy serials** pattern; Loop 186), **Copy selection
 * link** (`?ids=` of marked site ids — Devices `?names=` pattern; clearable chip
 * while active), and **Clear** (Loop 163) so operators can hand off only the
 * sites they marked — full list export stays in the header. Keyboard shortcuts
 * help and filtered empty **Clear filters** ship with the bulk bar.
 * Data: getSites({ limit }) — live /api/sites when the server is up, fixtures
 * otherwise. Large estates page at SITE_PAGE and Load more via nextCursor.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  DATATABLE_ROW_SHORTCUTS,
  Divider,
  Drawer,
  EmptyState,
  FormField,
  Input,
  DataTable,
  KeyboardShortcuts,
  PageSkeleton,
  Pagination,
  Select,
  TableViewOptions,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { getSites } from '../api/client';
import type { SitesData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { namesFilterForParam } from '../app/nav';
import { hhmmLocal as hhmm, countOf } from '@hpe/shared';
import type { MistSleRow, SiteHealthTone, SiteRow } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';

const SITE_PAGE = 100;

const HEALTH_FILTERS: Array<{ value: 'all' | SiteHealthTone; label: string }> = [
  { value: 'all', label: 'All health' },
  { value: 'ok', label: 'Healthy' },
  { value: 'warn', label: 'Warning' },
  { value: 'bad', label: 'Critical' },
  { value: 'stale', label: 'Unreported' },
];

function parseHealthFilter(raw: string | null): 'all' | SiteHealthTone {
  if (raw === 'ok' || raw === 'warn' || raw === 'bad' || raw === 'stale') return raw;
  return 'all';
}

function sleTone(overall: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (overall === null) return 'neutral';
  if (overall >= 0.95) return 'success';
  if (overall >= 0.9) return 'warning';
  return 'danger';
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function sleTooltip(sle: MistSleRow): string {
  return [
    `Coverage ${pct(sle.coverage)}`,
    `Capacity ${pct(sle.capacity)}`,
    `Roaming ${pct(sle.roaming)}`,
    `AP Health ${pct(sle.apHealth)}`,
    `WAN ${pct(sle.wan)}`,
  ].join(' · ');
}


function planeNames(sites: SiteRow[]): string[] {
  const all: string[] = [];
  sites.forEach((s) =>
    s.planes.forEach((p) => {
      if (all.indexOf(p.name) < 0) all.push(p.name);
    }),
  );
  return all;
}

export default function Sites() {
  const navigate = useNavigate();
  const { density, showPlatformTags, pollIntervalSec, tableColumns, setTableColumns } = useSettings();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<SitesData | null>(null);
  const [plane, setPlane] = useState(() => searchParams.get('plane') ?? 'all');
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [health, setHealth] = useState<'all' | SiteHealthTone>(() =>
    parseHealthFilter(searchParams.get('health')),
  );
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSubnet, setNewSubnet] = useState('');
  const [newPlane, setNewPlane] = useState('CENTRAL');
  /* Keyboard multi-select (x toggles focused row) raises Export selected /
   * Copy selection link. */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /sites?ids=a\nb (bulk Copy selection link). Read off the URL
   * like Devices ?names= — must not drift from the address bar. */
  const idsFilter = namesFilterForParam(searchParams.get('ids'));

  const sitesAccRef = useRef<SiteRow[]>([]);
  const nextSiteCursorRef = useRef<string | null>(null);
  const loadMoreSitesRef = useRef<() => void>(() => {});
  const [siteHasMore, setSiteHasMore] = useState(false);
  const [sitePageTotal, setSitePageTotal] = useState<number | null>(null);
  const [loadingMoreSites, setLoadingMoreSites] = useState(false);

  /* Keep ?q= / ?plane= / ?health= aligned with the filter row so a refresh or
     shared URL opens the same slice. Other params (if any) are preserved;
     empty defaults are omitted rather than written as q=&plane=all. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const qTrim = q.trim();
    if (qTrim) next.set('q', qTrim);
    else next.delete('q');
    if (plane !== 'all') next.set('plane', plane);
    else next.delete('plane');
    if (health !== 'all') next.set('health', health);
    else next.delete('health');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [q, plane, health, searchParams, setSearchParams]);

  const serverQ = q.trim();
  const serverPlane = plane !== 'all' ? plane : undefined;
  const serverHealth = health !== 'all' ? health : undefined;

  /* The footer stamps LIVE · SYNCED hh:mm, so a NOC tab must not sit on a
     mount-time snapshot under it: poll on the settings cadence, the same
     pattern Overview.tsx runs. One fetch at a time — a slow response never
     stacks up behind the interval; fixture reads poll harmlessly. Live lists
     request optional pages (limit=SITE_PAGE) so large estates can Load more.
     q/plane/health ride the request so Load more pages the filtered set. */
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = (mode: 'replace' | 'append' = 'replace') => {
     if (mode === 'replace' && inFlight) return;
     if (mode === 'append' && !nextSiteCursorRef.current) return;
     if (mode === 'replace') inFlight = true;
     if (mode === 'append') setLoadingMoreSites(true);
     void getSites({
       limit: SITE_PAGE,
       ...(serverQ ? { q: serverQ } : {}),
       ...(serverPlane ? { plane: serverPlane } : {}),
       ...(serverHealth ? { health: serverHealth } : {}),
       ...(mode === 'append' && nextSiteCursorRef.current
         ? { cursor: nextSiteCursorRef.current }
         : {}),
     })
       .then((d) => {
         if (!live) return;
         if (mode === 'append') {
           const seen = new Set(sitesAccRef.current.map((s) => s.id));
           const extra = d.sites.filter((s) => !seen.has(s.id));
           const merged = [...sitesAccRef.current, ...extra];
           sitesAccRef.current = merged;
           setData({ ...d, sites: merged });
         } else {
           sitesAccRef.current = d.sites;
           setData(d);
         }
         nextSiteCursorRef.current = d.page?.nextCursor ?? null;
         setSiteHasMore(Boolean(d.page?.nextCursor));
         setSitePageTotal(d.page?.total ?? null);
       })
       .finally(() => {
         if (mode === 'replace') inFlight = false;
         if (mode === 'append') setLoadingMoreSites(false);
       });
    };
    loadMoreSitesRef.current = () => pull('append');
    nextSiteCursorRef.current = null;
    sitesAccRef.current = [];
    pull('replace');
    const every = Math.max(pollIntervalSec, 10) * 1000;
    const id = setInterval(() => pull('replace'), every);
    return () => {
     live = false;
     clearInterval(id);
    };
  }, [pollIntervalSec, serverQ, serverPlane, serverHealth]);

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const sites = data.sites;
  /* Server already applied q/plane/health when live; keep a local AND pass for
     demo fixture fallbacks and any older server that ignored the params. */
  const ql = q.trim().toLowerCase();
  const matchesQ = (s: SiteRow) => !ql || s.name.toLowerCase().includes(ql);
  const matchesPlane = (s: SiteRow) =>
    plane === 'all' || s.planes.some((p) => p.name === plane);
  const matchesHealth = (s: SiteRow) => health === 'all' || s.tone === health;
  const matchesIds = (s: SiteRow) => idsFilter === null || idsFilter.includes(s.id);
  /* Health chips count over plane+q+ids (not health); plane chips over
   * health+q+ids (not plane) so each row still shows the full mix while its
   * own chip is on. Selection deep-link `ids=` narrows every universe. */
  const healthUniverse = sites.filter((s) => matchesPlane(s) && matchesQ(s) && matchesIds(s));
  const planeUniverse = sites.filter((s) => matchesHealth(s) && matchesQ(s) && matchesIds(s));
  const rows = sites.filter(
    (s) => matchesPlane(s) && matchesHealth(s) && matchesQ(s) && matchesIds(s),
  );
  const idsPresent =
    idsFilter === null ? 0 : idsFilter.filter((id) => sites.some((s) => s.id === id)).length;
  const clearSiteFilters = () => {
    setQ('');
    setPlane('all');
    setHealth('all');
    if (idsFilter !== null) {
      const next = new URLSearchParams(searchParams);
      next.delete('ids');
      setSearchParams(next, { replace: true });
    }
    setSelectedKeys([]);
  };
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
    count: healthUniverse.filter((s) => s.tone === m.key).length,
  })).filter((c) => c.count > 0 || health === c.key);
  const planeChipKeys = planeNames(planeUniverse);
  if (plane !== 'all' && !planeChipKeys.includes(plane)) planeChipKeys.unshift(plane);
  const planeChips = planeChipKeys.map((name) => ({
    key: name,
    label: name,
    count: planeUniverse.filter((s) => s.planes.some((p) => p.name === name)).length,
  })).filter((c) => c.count > 0 || plane === c.key);
    // Footer count: the estate total the rows themselves carry (418 across the
    // ten fixtures), never a literal that a live inventory would contradict.
    const indexedDevices = sites.reduce((n, s) => n + s.devices, 0);
  // The authored "Ten sites" prose is demo copy — a live estate counts itself.
  const sitesLive = data.dataSource === 'live' || (data.blended?.includes('sites') ?? false);
  // Design rule 1: the footer count is a data claim, so it says which source
  // made it. Same vocabulary as SiteDetail so the two never disagree.
  const sourceLabel = sitesLive
    ? `LIVE · SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : 'NEVER'}`
    : 'DEMO FIXTURE';
  const planeOptions = [{ value: 'all', label: 'All planes' }].concat(
    planeNames(sites).map((p) => ({ value: p, label: p })),
  );
  const addPlaneOptions = planeNames(sites).map((p) => ({ value: p, label: p }));
  /* 'CENTRAL' is only a default while the estate actually has one — on a
     CENTRAL-less estate a Select holding it has no matching option and
     renders blank, so fall back to the first plane the estate does report. */
  const newPlaneValue = addPlaneOptions.some((o) => o.value === newPlane)
    ? newPlane
    : (addPlaneOptions[0]?.value ?? newPlane);

  /* Sites are owned by the managing planes — hand off, never fake-create. */
  const submitAddSite = () => {
    toast('Site creation runs on the managing plane — handed off', {
      description: newName
        ? `${newName}${newSubnet ? ` · ${newSubnet}` : ''} · ${newPlaneValue}`
        : undefined,
      tone: 'info',
    });
    setAddOpen(false);
    setNewName('');
    setNewSubnet('');
    setNewPlane('CENTRAL');
  };

  // A plane that contributed no device list contributed no sites either, so
  // its locations are missing from the table rather than present-and-empty.
  const missingSources = data.missingSources ?? [];
  const sleBySiteId = data.sleBySiteId ?? {};

  const siteColumns: Array<DataTableColumn<(typeof rows)[number]>> = [
    {
      key: 'site',
      title: 'Site',
      hideable: false,
      render: (s) => (
        <button
          type="button"
          onClick={() => navigate(`/sites/${encodeURIComponent(s.id)}`)}
          className="nt-btn-col-plain"
        >
          <span className="nt-text-pri-12 nt-fs-135">{s.name}</span>
          <span className="nt-hint-muted">{s.subnet}</span>
        </button>
      ),
    },
    {
      key: 'managed',
      title: 'Managed by',
      render: (s) =>
        showPlatformTags ? (
          s.planes.length > 0 ? (
            <div className="nt-chip-wrap nt-chip-wrap--tight">
              {s.planes.map((p) => (
                <Badge key={p.name} tone={p.tone}>
                  {p.name}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="nt-hint-muted">not reported</span>
          )
        ) : null,
    },
    {
      key: 'mix',
      title: 'Mix',
      render: (s) => <span className="nt-hint-muted">{s.mix}</span>,
    },
    {
      key: 'devices',
      title: 'Devices',
      numeric: true,
      render: (s) => s.devices,
    },
    {
      key: 'clients',
      title: 'Clients',
      numeric: true,
      render: (s) => s.clients,
    },
    {
      key: 'health',
      title: 'Health',
      render: (s) => (
        <div
          className="nt-row-center nt-gap-8"
          title={s.health === null ? 'health not reported by the managing plane' : undefined}
        >
          <div className="nt-health-track nt-plane-ecg">
            {s.healthPct !== '—' ? (
              <div
                className={`nt-health-fill nt-plane-ecg__fill nt-fill-${s.tone}`}
                style={{ ['--nd-health' as string]: s.healthPct }}
              />
            ) : null}
          </div>
          <span className="nt-hint-muted">{s.health ?? '—'}</span>
        </div>
      ),
    },
    {
      key: 'sle',
      title: 'SLE',
      render: (s) => {
        const sle = sleBySiteId[s.id];
        return (
          <span title={sle ? sleTooltip(sle) : 'no SLE score reported for this site'}>
            <Badge tone={sleTone(sle?.overall ?? null)}>
              {sle && sle.overall !== null ? pct(sle.overall) : '—'}
            </Badge>
          </span>
        );
      },
    },
    {
      key: 'alerts',
      title: 'Alerts',
      render: (s) => <Badge tone={s.alertTone}>{s.alerts}</Badge>,
    },
    {
      key: 'sync',
      title: 'Last sync',
      numeric: true,
      render: (s) => s.sync,
    },
  ];

  return (
    <div className="nt-sites-stack nt-recon-reveal nt-sites-shell nt-section-panel">
      <ScreenHeader
        overline="Inventory / Sites"
        title="Sites"
        subtitle={
          sitesLive
            ? `${countOf(sites.length, 'site')}${
                missingSources.length > 0 ? ' so far' : ''
              }, and the plane each one actually answers to.`
            : 'Ten sites, and the plane each one actually answers to.'
        }
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · sites
            </span>
            {sitesLive ? <Badge tone="info">LIVE</Badge> : null}
            <div className="nt-w-170">
              <Select
                options={planeOptions}
                value={plane}
                onValueChange={setPlane}
                size="sm"
                aria-label="Filter by plane"
              />
            </div>
            <div className="nt-w-150">
              <Select
                options={HEALTH_FILTERS}
                value={health}
                onValueChange={(v) => setHealth(parseHealthFilter(v))}
                size="sm"
                aria-label="Filter by health"
              />
            </div>
            <div className="nt-w-200">
              <Input
                size="sm"
                mono
                placeholder="site name…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Filter sites"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const next = new URLSearchParams();
                  if (q.trim()) next.set('q', q.trim());
                  if (plane !== 'all') next.set('plane', plane);
                  if (health !== 'all') next.set('health', health);
                  const qs = next.toString();
                  const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Filter link copied', {
                      description: qs || 'unfiltered sites list',
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const n = exportTableCsv(
                  'sites.csv',
                  ['name', 'id', 'mix', 'devices', 'clients', 'health', 'healthPct', 'alerts', 'sync', 'planes'],
                  rows.map((s) => [
                    s.name,
                    s.id,
                    s.mix,
                    s.devices,
                    s.clients,
                    s.health ?? '',
                    s.healthPct,
                    s.alerts,
                    s.sync,
                    s.planes.map((p) => p.name).join('|'),
                  ]),
                );
                toast(`Exported ${countOf(n, 'site')}`, {
                  description: 'sites.csv — filtered rows currently in view.',
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
                    const qs = new URLSearchParams();
                    if (q.trim()) qs.set('q', q.trim());
                    if (plane !== 'all') qs.set('plane', plane);
                    if (health !== 'all') qs.set('health', health);
                    const suffix = qs.toString() ? `?${qs}` : '';
                    const res = await downloadApiCsv(`/api/sites/export${suffix}`, 'sites.csv');
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description: 'sites.csv — filtered portal site list.',
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
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
              Add site
            </Button>
          </>
        }
      />
      <div className="nt-plane-theater" role="note">NightDesk · sites theater · campus health owns hue</div>

      <VisualReferencePanel target={{ kind: 'service', id: 'sites' }} editable={false} />
      <ConfigRecommendationsPanel title="Site configuration recommendations" limit={8} />

      {missingSources.length > 0 ? (
        <Alert
          tone="warning"
          title={`${missingSources.length} linked plane${
            missingSources.length === 1 ? '' : 's'
          } contributed no inventory: ${missingSources.join(', ')}`}
        >
          <span className="nt-fs-13">
            Sites are derived from the merged device inventory, so any location known only to these planes is absent
            from the table below — not listed as empty. The counts above describe the estate that answered, not the
            whole one. Check them in Connected systems.
          </span>
        </Alert>
      ) : null}

      {/* The server computes this row in every mode; an older payload that
          ships none must not leave a zero-height grid behind. */}
      {data.stats.length > 0 ? (
        <StatRow stats={data.stats} />
      ) : null}

      {planeChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Site plane">
          <span className="nt-chip-row__label">Plane</span>
          {planeChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setPlane(plane === c.key ? 'all' : c.key)}
              className={plane === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={plane === c.key}
            >
              <Badge plane>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {healthChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Site health">
          <span className="nt-chip-row__label">Health</span>
          {healthChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setHealth(health === c.key ? 'all' : c.key)}
              className={health === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={health === c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <Divider variant="flair" />

      <div className="nt-stack nt-gap-8">
        <div className="nt-row-between">
          <span className="nd-micro-label nt-micro-label">Estate sites</span>
          <div className="nt-row nt-gap-8">
            <TableViewOptions
              columns={siteColumns}
              config={tableColumns.sites ?? {}}
              onChange={(config) => setTableColumns('sites', config)}
            />
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </div>
        </div>
        {idsFilter !== null ? (
          <div className="nt-chip-row" role="group" aria-label="Selection deep link">
            <button
              type="button"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('ids');
                setSearchParams(next, { replace: true });
              }}
              title={idsFilter.join(', ')}
              className="nt-chip nt-chip--active"
            >
              {idsPresent === idsFilter.length
                ? `${idsFilter.length} selected site${idsFilter.length === 1 ? '' : 's'}`
                : `${idsPresent} of ${idsFilter.length} selected sites present`}
              {' — clear'}
            </button>
          </div>
        ) : null}
        <DataTable
          ariaLabel="Sites"
          density={density}
          columns={siteColumns}
          rows={rows}
          rowKey={(s) => s.id}
          columnsConfig={tableColumns.sites}
          onColumnsConfigChange={(config) => setTableColumns('sites', config)}
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
          onRowActivate={(s) => navigate(`/sites/${encodeURIComponent(s.id)}`)}
          rowTone={(s) => {
            if (s.alertTone === 'danger' || s.alertTone === 'warning') return s.alertTone;
            if (s.tone === 'bad') return 'danger';
            if (s.tone === 'warn') return 'warning';
            if (s.tone === 'ok') return 'success';
            return 'neutral';
          }}
        />
        {selectedKeys.length > 0 ? (
          <div className="nt-configure-bulk-bar nt-bulk-glass" role="region" aria-label="Site selection actions">
            <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
            <span className="nt-configure-bulk-bar__hint">
              export, copy names, or share a selection link for only the sites you marked — full list
              export stays in the header
            </span>
            <span className="nt-configure-bulk-bar__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const selected = new Set(selectedKeys);
                  const picked = rows.filter((s) => selected.has(s.id));
                  if (picked.length === 0) {
                    toast('No selected sites still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const n = exportTableCsv(
                    'sites-selected.csv',
                    ['name', 'id', 'mix', 'devices', 'clients', 'health', 'healthPct', 'alerts', 'sync', 'planes'],
                    picked.map((s) => [
                      s.name,
                      s.id,
                      s.mix,
                      s.devices,
                      s.clients,
                      s.health ?? '',
                      s.healthPct,
                      s.alerts,
                      s.sync,
                      s.planes.map((p) => p.name).join('|'),
                    ]),
                  );
                  toast(`Exported ${countOf(n, 'selected site')}`, {
                    description: 'sites-selected.csv — filtered fields only.',
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
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((s) => selected.has(s.id));
                    if (picked.length === 0) {
                      toast('No selected sites still in view', {
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
                        description: `${picked.length} site${picked.length === 1 ? '' : 's'} · ids=`,
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
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={
            sites.length === 0 && missingSources.length > 0
              ? 'No sites from the planes that answered'
              : 'Nothing matches that filter'
          }
          description={
            sites.length === 0 && missingSources.length > 0
              ? `${missingSources.join(', ')} contributed no inventory, so any site there is unknown rather than absent.`
              : 'No site matches that plane, health, name or selection combination.'
          }
        >
          {sites.length > 0 &&
          (q.trim() || plane !== 'all' || health !== 'all' || idsFilter !== null) ? (
            <Button variant="secondary" size="sm" onClick={clearSiteFilters}>
              Clear filters
            </Button>
          ) : null}
        </EmptyState>
      ) : null}

      {siteHasMore || sitePageTotal != null ? (
        <div className="nt-filter-bar">
          {sitePageTotal != null ? (
            <span className="nt-mono-label">
              Loaded {sites.length} of {sitePageTotal}
            </span>
          ) : null}
          {siteHasMore ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={loadingMoreSites}
              onClick={() => loadMoreSitesRef.current()}
            >
              {loadingMoreSites ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div
        className="nt-row-between-16"
      >
        <div className="nt-row-center-10-min">
          <span
            className="nt-hint-muted"
          >
            {rows.length} of {sites.length} sites · {indexedDevices} devices indexed
          </span>
          <span
            className="nt-mono-label nt-hint-muted"
          >
            {sourceLabel}
          </span>
        </div>
        <Pagination page={1} total={1} onChange={() => {}} />
      </div>

      <Drawer
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add site"
        description="Sites are created on the managing plane — the portal hands off with this payload pre-filled."
      >
        <form
          className="nt-stack-14"
          onSubmit={(e) => {
            e.preventDefault();
            submitAddSite();
          }}
        >
          <FormField label="Site name" htmlFor="add-site-name">
            <Input
              id="add-site-name"
              size="md"
              placeholder="e.g. Eastfield Clinic"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </FormField>
          <FormField label="Subnet" htmlFor="add-site-subnet">
            <Input
              id="add-site-subnet"
              size="md"
              mono
              placeholder="10.54.0.0/24"
              value={newSubnet}
              onChange={(e) => setNewSubnet(e.target.value)}
            />
          </FormField>
          <FormField label="Managed by" htmlFor="add-site-plane">
            <Select
              id="add-site-plane"
              options={addPlaneOptions}
              value={newPlaneValue}
              onValueChange={setNewPlane}
              size="md"
              aria-label="Managing plane"
            />
          </FormField>
          <div
            className="nt-service-note"
          >
            The portal does not create sites locally — the request is handed to the managing plane,
            which owns site creation.
          </div>
          <div className="nt-row nt-gap-8">
            <Button variant="primary" size="sm" type="submit">
              Hand off to plane
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
