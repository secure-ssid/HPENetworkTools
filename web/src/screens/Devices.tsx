/**
 * web/src/screens/Devices.tsx — unified inventory with two presentations.
 * High-fidelity port of design/NtDevices.dc.html: header SegmentedControl
 * ("Unified table" | "Platform lanes") bound to the global inventoryView
 * setting (the prototype's local-override bug is not carried over), filter
 * row (search, type Select, FacetFilter popovers — plane, state, site, each a
 * checklist with live counts, OR-within / AND-across — **Type** chips (counts over
 * issues+q+names+state — Loop 153) + **Issues** chips +
 * "Reconciliation issues only" Switch sharing `?issues=`, **State** chips sharing
 * the same `?state=` deep-link write-back (Loop 154), **Plane** chips sharing the
 * same `plane` facet / `?plane=` write-back (Loop 157), **Site** chips sharing the
 * same `site` facet / `?site=` write-back (Loop 156), saved-views dropdown,
 * mono `N of M indexed` count), warning
 * Alert with the reconciliation truth
 * (counts from the payload's reconciliation block — live reconciler totals, or
 * the authored estate figures in demo, never a tally of the sample rows), then
 * either the open unified table (every claiming plane in Managed by, plus a
 * double-claimed / no-cloud-plane marker beside State) or the platform-lanes
 * grid (one lane per plane the payload published lane meta for — INCLUDING a
 * linked plane that reported nothing, which is the gap the view exists to
 * show — meta from the payload's lanes map, 2px bottom rule in the plane's
 * mark colour, 520px own scroll). Filters are local, instant and additive:
 * the free-text search, the type Select, the switches, the URL deep links and
 * the facets all compose by AND — the facets simply sit last in the pipeline,
 * with their counts computed over the rows every other filter let through
 * (and, per facet, over the OTHER facets' selections, so ticking one value
 * never zeroes a sibling's count). Search covers every key the placeholder
 * advertises (name, model, site, serial, MAC, management IP); an empty table
 * shows the EmptyState. The header
 * subtitle states the authored estate totals in demo and is derived from the
 * payload in live/blend — it never asserts a fixture count over real data.
 * Deep links it honours: ?plane= (Systems drawer — seeds the plane facet),
 * ?names= (a Compliance
 * finding's set) and ?state= (an availability count's state slice — also the
 * **State** chip row) — each
 * read straight off the URL and each showing a clearable chip while it
 * narrows the list. Filter-row state also writes back to the address bar
 * (`q`, `type`, `issues`, `plane`, `site`) so **Copy view link** shares the
 * same slice a refresh would reopen — same Sites pattern.
 *
 * The unified table is the nightdesk DataTable reference integration: the
 * column manager (View options dropdown + header-edge resize) persists its
 * controlled config through SettingsContext under the 'devices' table id,
 * the rows are a keyboard grid (j/↓ k/↑ move, Enter/→ opens the device, x
 * selects, Esc clears — '?' lists them). A non-empty selection raises the
 * bulk bar: Export selected, Copy selection link (`?names=` of the marked
 * devices), **Copy serials** (newline-joined inventory serials for paste into
 * a ticket / RMA), and Clear. Filtered empties offer **Clear filters** (Loop 202).
 * Header **LIVE** stamps pure live and blend feeds
 * alike (Loop 163). No column tints because nothing here has a
 * meaningful threshold. The rollout guide for the other screens lives in
 * DataTable.tsx's module comment. Saved views (the Views dropdown)
 * capture the facet selection, free text, type and issues-only switch, the
 * column config and the density, named and persisted through SettingsContext
 * under the 'devices' screen id; the URL deep links are NOT captured — a
 * filter that narrows this hard belongs to the address that explains it.
 *
 * Data: getDevices() — live /api/devices when the server is up, fixtures otherwise.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  DATATABLE_ROW_SHORTCUTS,
  DataTable,
  EmptyState,
  Input,
  KeyboardShortcuts,
  SegmentedControl,
  Select,
  Sparkline,
  PageSkeleton,
  Switch,
  TableViewOptions,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { getDevices, getMetricsHistory, metricsWindowLabel, savePortalSettings } from '../api/client';
import type { DevicesData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import type { InventoryView, SavedView } from '../app/SettingsContext';
import { applyFacets, FacetFilter, sanitizeFacetSelection } from '../components/FacetFilter';
import type { FacetDef, FacetSelection } from '../components/FacetFilter';
import { SavedViews } from '../components/SavedViews';
import { deviceDetailPath, namesFilterForParam, planeFilterForParam, stateFilterForParam } from '../app/nav';
import {
  paletteActionCue,
  parsePaletteAction,
  stripActionParam,
  type PaletteActionId,
} from '../app/actionDeepLink';
import { UNKNOWN_LANE_META, countOf } from '@hpe/shared';
import type { DeviceRow, MetricsHistoryEnvelope, Plane, Tone } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { ApiErrorState } from './ApiErrorState';
import { DeviceTypeBadge } from '../components/DeviceTypeBadge';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { getTaxonomySummary } from '../api/recommendations';
import type { CategoryBucket } from '@hpe/shared';
import '../app/app.css';

/** `?issues=` triage — 1/true = issues only, 0/false = clean only, else all. */
export function parseDevicesIssuesFilter(raw: string | null): 'all' | '1' | '0' {
  const v = raw?.trim().toLowerCase() ?? '';
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return '1';
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return '0';
  return 'all';
}

function displayField(value: string): string {
  const normal = value.trim().toLowerCase();
  return !value || normal === '—' || normal === 'unknown' ? 'Not reported' : value;
}

const VIEW_OPTIONS = [
  { value: 'Unified table', label: 'Unified table' },
  { value: 'Platform lanes', label: 'Platform lanes' },
];

/** Fallback for a plane the payload carries no lane meta for. Honesty rule 1:
 *  a lane with no freshness stamp says so — it never claims to be linked. The
 *  shared constant is the same one the server's live lane builder falls back
 *  to, so the two copies cannot drift. */
const FALLBACK_LANE = UNKNOWN_LANE_META;

/**
 * The per-device attached-client sparkline cell. An absent series is honest
 * text, never a flat line: it means no client attributed itself to this
 * device, which is not a measurement of zero.
 */
function DeviceClientsSpark({
  metrics,
  name,
  compact,
}: {
  metrics: MetricsHistoryEnvelope;
  name: string;
  compact: boolean;
}) {
  const windowLabel = metricsWindowLabel(metrics);
  const series = metrics.deviceClients[name] ?? [];
  const latest = series.length > 0 ? series[series.length - 1]!.v : null;
  if (series.length >= 2 && latest !== null) {
    return (
      <span className="nt-row-center nt-gap-6 nt-inline-flex">
        <Sparkline
          points={series}
          width={72}
          height={compact ? 14 : 18}
          label={`${latest} attached client${latest === 1 ? '' : 's'} · ${windowLabel}`}
        />
        <span className="nt-mono-11 nt-text-sec">{latest}</span>
      </span>
    );
  }
  if (series.length === 1) {
    return (
      <span className="nt-hint-muted" title={`one sample so far · ${windowLabel}`}>
        1 sample
      </span>
    );
  }
  return (
    <span className="nt-hint-muted" title="no attached-client samples for this device">
      —
    </span>
  );
}

/** Every plane that claims this row. The reconciler ships `claimedBy` on live
 *  rows; the authored fixtures encode the double claim in `state` instead and
 *  carry no claimant list, so they fall back to the single display plane. */
function claimantsOf(d: DeviceRow): Plane[] {
  return d.claimedBy?.length ? d.claimedBy : [d.plane];
}

/** Row-level reconciliation marker (design rule 2 — one flagged row, never a
 *  duplicate), or null when the row reconciles cleanly. Only rows carrying a
 *  claimant list get one: the fixtures already say 'double-claimed' in State. */
function reconciliationMark(d: DeviceRow): { label: string; tone: Tone } | null {
  if (!d.claimedBy || !d.reconciliationIssue) return null;
  return d.claimedBy.length > 1
    ? { label: 'double-claimed', tone: 'danger' }
    : { label: 'no cloud plane', tone: 'warning' };
}

export default function Devices() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { density, setDensity, inventoryView, setInventoryView, showPlatformTags, pollIntervalSec, tableColumns, setTableColumns, savedViews, setSavedViews } = useSettings();
  const [data, setData] = useState<DevicesData | null>(null);
  /* The attached-client sparkline column rides the metrics-history envelope,
   * not the devices payload: one extra small GET, and null (older server,
   * unreachable API) hides the column rather than painting invented history. */
  const [metrics, setMetrics] = useState<MetricsHistoryEnvelope | null>(null);
  /* Row selection for the unified table's keyboard grid. Selection raises the
   * bulk bar (Export selected / Copy selection link) — same contextual pattern
   * as Alerts and Configure's queue. */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [type, setType] = useState(() => {
    const t = searchParams.get('type')?.trim();
    return t && t.length > 0 ? t : 'all';
  });
  /* Faceted filtering (plane / state / site) — OR within a facet, AND across
   * facets, composed with the search, type Select, switch and URL filters.
   * The ?plane= / ?site= deep links seed the matching facets. */
  const [facets, setFacets] = useState<FacetSelection>(() => {
    const initial: FacetSelection = {};
    const planes = (searchParams.get('plane') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => planeFilterForParam(p))
      .filter((p) => p !== 'all');
    if (planes.length > 0) initial.plane = planes;
    const sites = (searchParams.get('site') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (sites.length > 0) initial.site = sites;
    return initial;
  });
  /* Issues triage: all | issues-only (`1`) | clean-only (`0`) — chips + Switch
   * share the same `?issues=` write-back (Loop 145). */
  const [issuesFilter, setIssuesFilter] = useState<'all' | '1' | '0'>(() =>
    parseDevicesIssuesFilter(searchParams.get('issues')),
  );
  const issuesOnly = issuesFilter === '1';
  const setIssuesOnly = (on: boolean) => setIssuesFilter(on ? '1' : 'all');
  const [typeBuckets, setTypeBuckets] = useState<CategoryBucket[]>([]);
  /* Deep link: /devices?names=a\nb\nc (a Compliance finding's count). Read
     straight off the URL rather than mirrored into state — a filter that
     narrows the estate this hard must not be able to drift from the address
     that explains it, and clearing it is then just dropping the param. */
  const nameFilter = namesFilterForParam(searchParams.get('names'));
  /* Deep link: /devices?state=<state> (an availability count's slice — the
     Overview's device tile, a shared view). Same read-off-the-URL rule as
     names, for the same reason. */
  const stateFilter = stateFilterForParam(searchParams.get('state'));

  // Hide a fixture row from the demo inventory (persisted server-side);
  // optimistic local update, rollback on failure.
  const hideDevice = async (name: string) => {
    if (!data) return;
    const prev = data;
    setData({
      ...data,
      devices: data.devices.filter((d) => d.name !== name),
      hiddenDevices: [...(data.hiddenDevices ?? []), name],
    });
    const res = await savePortalSettings({
      hiddenDemoDevices: [...(prev.hiddenDevices ?? []), name],
    });
    if (!res.ok) {
      setData(prev);
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(`${name} hidden from the demo inventory`, {
      description: 'bring it back from the hidden chip in the filter row.',
      tone: 'info',
    });
  };

  const restoreHidden = async () => {
    if (!data) return;
    const res = await savePortalSettings({ hiddenDemoDevices: [] });
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    const fresh = await getDevices({
      limit: DEVICE_PAGE,
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(type !== 'all' ? { type } : {}),
      ...(issuesFilter !== 'all' ? { issues: issuesFilter } : {}),
      ...((facets.plane ?? []).length > 0 ? { plane: (facets.plane ?? []).join(',') } : {}),
      ...((facets.site ?? []).length > 0 ? { site: (facets.site ?? []).join(',') } : {}),
    });
    devicesAccRef.current = fresh.devices;
    nextDeviceCursorRef.current = fresh.page?.nextCursor ?? null;
    setDeviceHasMore(Boolean(fresh.page?.nextCursor));
    setDevicePageTotal(fresh.page?.total ?? null);
    setData(fresh);
    toast('Hidden demo devices restored', { tone: 'success' });
  };

  /* The lanes view stamps each plane's freshness from this payload, so a NOC
     tab must not sit on a mount-time snapshot: poll on the settings cadence,
     the same pattern Overview.tsx runs. One fetch at a time — a slow response
     never stacks up behind the interval; fixture reads poll harmlessly.
     Live lists request optional pages (limit=250) so large estates can Load more
     without forcing every poll to ship the full inventory.
     q/type/issues/plane/site/state ride the request so Load more pages the
     filtered set (server applyDeviceListFilters). */
  const devicesAccRef = useRef<DeviceRow[]>([]);
  const nextDeviceCursorRef = useRef<string | null>(null);
  const loadMoreDevicesRef = useRef<() => void>(() => {});
  const [deviceHasMore, setDeviceHasMore] = useState(false);
  const [devicePageTotal, setDevicePageTotal] = useState<number | null>(null);
  const [loadingMoreDevices, setLoadingMoreDevices] = useState(false);
  const DEVICE_PAGE = 250;

  const serverQ = q.trim();
  const serverType = type !== 'all' ? type : undefined;
  const serverIssues = issuesFilter !== 'all' ? issuesFilter : undefined;
  const serverPlane =
    (facets.plane ?? []).length > 0 ? (facets.plane ?? []).join(',') : undefined;
  const serverSite =
    (facets.site ?? []).length > 0 ? (facets.site ?? []).join(',') : undefined;
  const serverState = (() => {
    if (stateFilter) return stateFilter;
    const st = facets.state ?? [];
    return st.length > 0 ? st.join(',') : undefined;
  })();

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = (mode: 'replace' | 'append' = 'replace') => {
      if (mode === 'replace' && inFlight) return;
      if (mode === 'append' && !nextDeviceCursorRef.current) return;
      if (mode === 'replace') inFlight = true;
      if (mode === 'append') setLoadingMoreDevices(true);
      void getDevices({
        limit: DEVICE_PAGE,
        ...(serverQ ? { q: serverQ } : {}),
        ...(serverType ? { type: serverType } : {}),
        ...(serverIssues ? { issues: serverIssues } : {}),
        ...(serverPlane ? { plane: serverPlane } : {}),
        ...(serverSite ? { site: serverSite } : {}),
        ...(serverState ? { state: serverState } : {}),
        ...(mode === 'append' && nextDeviceCursorRef.current
          ? { cursor: nextDeviceCursorRef.current }
          : {}),
      })
        .then((d) => {
          if (!live) return;
          if (mode === 'append') {
            const seen = new Set(devicesAccRef.current.map((r) => `${r.name}|${r.serial ?? ''}|${r.plane}`));
            const extra = d.devices.filter((r) => !seen.has(`${r.name}|${r.serial ?? ''}|${r.plane}`));
            const merged = [...devicesAccRef.current, ...extra];
            devicesAccRef.current = merged;
            setData({ ...d, devices: merged });
          } else {
            devicesAccRef.current = d.devices;
            setData(d);
          }
          nextDeviceCursorRef.current = d.page?.nextCursor ?? null;
          setDeviceHasMore(Boolean(d.page?.nextCursor));
          setDevicePageTotal(d.page?.total ?? null);
        })
        .finally(() => {
          if (mode === 'replace') inFlight = false;
          if (mode === 'append') setLoadingMoreDevices(false);
        });
      if (mode === 'replace') {
        void getTaxonomySummary()
          .then((t) => {
            if (live) setTypeBuckets(t.devices.byType);
          })
          .catch(() => {
            /* optional enrichment — inventory still works without it */
          });
        void getMetricsHistory().then((m) => {
          if (live) setMetrics(m);
        });
      }
    };
    loadMoreDevicesRef.current = () => pull('append');
    nextDeviceCursorRef.current = null;
    devicesAccRef.current = [];
    pull('replace');
    const every = Math.max(pollIntervalSec, 10) * 1000;
    const id = setInterval(() => pull('replace'), every);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [
    pollIntervalSec,
    serverQ,
    serverType,
    serverIssues,
    serverPlane,
    serverSite,
    serverState,
  ]);

  /* Deep link: /devices?plane=<registryId> (from the Systems plane drawer).
     Applied when the URL changes while the screen is mounted — state adjusted
     during render rather than an effect that commits the stale filter first. */
  const [prevParams, setPrevParams] = useState(searchParams);
  if (prevParams !== searchParams) {
    setPrevParams(searchParams);
    const pp = searchParams.get('plane');
    if (pp !== null) {
      const planes = pp
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => planeFilterForParam(p))
        .filter((p) => p !== 'all');
      setFacets((cur) => {
        const next = { ...cur };
        if (planes.length === 0) delete next.plane;
        else next.plane = planes;
        return next;
      });
    }
    const qParam = searchParams.get('q');
    if (qParam !== null) setQ(qParam);
    const typeParam = searchParams.get('type');
    if (typeParam !== null) setType(typeParam.trim() || 'all');
    const issuesParam = searchParams.get('issues');
    if (issuesParam !== null) {
      setIssuesFilter(parseDevicesIssuesFilter(issuesParam));
    } else {
      setIssuesFilter('all');
    }
    const siteParam = searchParams.get('site');
    if (siteParam !== null) {
      const sites = siteParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      setFacets((cur) => {
        const next = { ...cur };
        if (sites.length === 0) delete next.site;
        else next.site = sites;
        return next;
      });
    }
  }

  /* ⌘K quick-action landing cue (`?action=diagnostics`) — one-shot. */
  const [actionCue, setActionCue] = useState<PaletteActionId | null>(() =>
    parsePaletteAction(searchParams.get('action')),
  );
  useEffect(() => {
    const parsed = parsePaletteAction(searchParams.get('action'));
    if (parsed !== 'diagnostics') return;
    setActionCue(parsed);
    const stripped = stripActionParam(searchParams);
    if (stripped) setSearchParams(stripped, { replace: true });
  }, [searchParams, setSearchParams]);

  /* Keep filter-row params aligned with local state so a refresh or shared URL
     opens the same client-side slice. Deep-link params (`names`, `state`) are
     preserved; empty defaults are omitted rather than written as q=&type=all.
     Never re-write `action` — the cue consumes it once. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    const qTrim = q.trim();
    if (qTrim) next.set('q', qTrim);
    else next.delete('q');
    if (type !== 'all') next.set('type', type);
    else next.delete('type');
    if (issuesFilter !== 'all') next.set('issues', issuesFilter);
    else next.delete('issues');
    const planes = facets.plane ?? [];
    if (planes.length > 0) next.set('plane', planes.join(','));
    else next.delete('plane');
    const sites = facets.site ?? [];
    if (sites.length > 0) next.set('site', sites.join(','));
    else next.delete('site');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [q, type, issuesFilter, facets, searchParams, setSearchParams]);

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const devices = data.devices;
  const isDemo =
    data.dataSource === 'demo' && !(data.blended?.includes('devices') ?? false);
  const hiddenCount = data.hiddenDevices?.length ?? 0;
  const ql = q.trim().toLowerCase();
  // The placeholder promises name, model, serial and ip — so all four are
  // searched. Serial/MAC/IP are optional on the row (fixtures carry none, live
  // adapters carry what their plane published), and a MAC pasted from another
  // tool rarely uses the same separators, so a separator-stripped pass runs
  // alongside the literal one.
  const qlBare = ql.replace(/[^a-z0-9]/g, '');
  const matchesQuery = (d: DeviceRow): boolean => {
    if (!ql) return true;
    const hay = [d.name, d.model, d.siteName, d.serial ?? '', d.mac ?? '', d.ip ?? '']
      .join(' ')
      .toLowerCase();
    if (hay.includes(ql)) return true;
    return qlBare.length >= 6 && hay.replace(/[^a-z0-9 ]/g, '').includes(qlBare);
  };
  /* The facet universe: every row the NON-facet filters (type Select, issues
     switch, URL deep links, free text) let through. The FacetFilter counts
     describe this set, and applyFacets narrows it to the rows the table and
     lanes show — so a count never promises rows the search box would hide. */
  const matchesIssues = (d: DeviceRow): boolean => {
    if (issuesFilter === '1') return Boolean(d.reconciliationIssue);
    if (issuesFilter === '0') return !d.reconciliationIssue;
    return true;
  };
  const uniq = <T,>(xs: T[]): T[] => xs.filter((v, i, a) => a.indexOf(v) === i);
  /* Type chips count over issues+q+names+state (not type); issues chips over
   * type+q+names+state (not issues) so each row still shows the full mix while
   * its own chip is on — Loop 153 type / Loop 145 issues. */
  const typeUniverse = devices.filter(
    (d) =>
      matchesIssues(d) &&
      (nameFilter === null || nameFilter.includes(d.name)) &&
      (stateFilter === null || d.state === stateFilter) &&
      matchesQuery(d),
  );
  const issuesUniverse = devices.filter(
    (d) =>
      (type === 'all' || d.type === type) &&
      (nameFilter === null || nameFilter.includes(d.name)) &&
      (stateFilter === null || d.state === stateFilter) &&
      matchesQuery(d),
  );
  const typeChipKeys = uniq(typeUniverse.map((d) => d.type).filter(Boolean)).sort((a, b) =>
    a.localeCompare(b),
  ) as string[];
  if (type !== 'all' && type && !typeChipKeys.includes(type)) typeChipKeys.unshift(type);
  const typeChips = typeChipKeys.map((key) => {
    const bucket = typeBuckets.find((b) => b.key === key);
    return {
      key,
      label: bucket?.label ?? key,
      tone: (bucket?.tone ?? 'neutral') as Tone,
      count: typeUniverse.filter((d) => d.type === key).length,
    };
  });
  const ISSUES_CHIP_META: Array<{ key: '1' | '0'; label: string; tone: Tone }> = [
    { key: '1', label: 'Issues', tone: 'warning' },
    { key: '0', label: 'Clean', tone: 'success' },
  ];
  const issuesChips = ISSUES_CHIP_META.map((m) => ({
    ...m,
    count: issuesUniverse.filter((d) =>
      m.key === '1' ? Boolean(d.reconciliationIssue) : !d.reconciliationIssue,
    ).length,
  })).filter((c) => c.count > 0 || issuesFilter === c.key);
  /* State chips count over type+q+names+issues (not state) and toggle the same
   * `?state=` deep link the availability counts / clearable chip use (Loop 154). */
  const stateUniverse = devices.filter(
    (d) =>
      (type === 'all' || d.type === type) &&
      matchesIssues(d) &&
      (nameFilter === null || nameFilter.includes(d.name)) &&
      matchesQuery(d),
  );
  const stateChipKeys = uniq(
    stateUniverse.map((d) => String(d.state ?? '').trim()).filter(Boolean),
  ).sort((a, b) => a.localeCompare(b));
  if (stateFilter && !stateChipKeys.includes(stateFilter)) stateChipKeys.unshift(stateFilter);
  const stateChips = stateChipKeys
    .map((key) => {
      const sample = stateUniverse.find((d) => d.state === key);
      return {
        key,
        label: key,
        tone: (sample?.stateTone ?? 'neutral') as Tone,
        count: stateUniverse.filter((d) => d.state === key).length,
        pressed: stateFilter === key,
      };
    })
    .filter((c) => c.count > 0 || c.pressed);
  const toggleStateChip = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (stateFilter === key) next.delete('state');
    else next.set('state', key);
    setSearchParams(next, { replace: true });
  };
  const baseRows = devices.filter(
    (d) =>
      (type === 'all' || d.type === type) &&
      matchesIssues(d) &&
      (nameFilter === null || nameFilter.includes(d.name)) &&
      (stateFilter === null || d.state === stateFilter) &&
      matchesQuery(d),
  );
  /* Site is faceted by id (two sites may share a display name — sparse live
     rows all read '—') and rendered by name; a ?plane= deep link that names a
     plane with no rows in this feed stays listed by the FacetFilter's
     selected-value union, count 0 — a hiding filter never turns invisible. */
  const deviceFacets: Array<FacetDef<DeviceRow>> = [
    { key: 'plane', label: 'Plane', values: (d) => [d.plane] },
    { key: 'state', label: 'State', values: (d) => [d.state] },
    {
      key: 'site',
      label: 'Site',
      values: (d) => [d.siteId],
      formatValue: (id) => devices.find((d) => d.siteId === id)?.siteName ?? id,
    },
  ];
  /* Plane chips count over the non-facet universe (same as FacetFilter's
   * baseRows) and toggle the `plane` facet / `?plane=` write-back — single-select
   * click again to clear (Loop 157). */
  const activePlanes = facets.plane ?? [];
  const planeChipKeys = uniq(
    baseRows.map((d) => String(d.plane ?? '').trim()).filter(Boolean),
  ).sort((a, b) => a.localeCompare(b));
  for (const p of activePlanes) {
    if (p && !planeChipKeys.includes(p)) planeChipKeys.unshift(p);
  }
  const planeChips = planeChipKeys
    .map((key) => {
      const sample = baseRows.find((d) => d.plane === key);
      return {
        key,
        label: key,
        tone: (sample?.planeTone ?? 'neutral') as Tone,
        count: baseRows.filter((d) => d.plane === key).length,
        pressed: activePlanes.length === 1 && activePlanes[0] === key,
      };
    })
    .filter((c) => c.count > 0 || c.pressed);
  const togglePlaneChip = (key: string) => {
    const cur = facets.plane ?? [];
    if (cur.length === 1 && cur[0] === key) {
      const next = { ...facets };
      delete next.plane;
      setFacets(next);
      return;
    }
    setFacets({ ...facets, plane: [key] });
  };
  /* Site chips count over the non-facet universe (same as FacetFilter's
   * baseRows) and toggle the `site` facet / `?site=` write-back — single-select
   * click again to clear (Loop 156). Keys are siteIds; labels prefer siteName. */
  const activeSites = facets.site ?? [];
  const siteChipKeys = uniq(
    baseRows.map((d) => String(d.siteId ?? '').trim()).filter(Boolean),
  ).sort((a, b) => {
    const an = devices.find((d) => d.siteId === a)?.siteName ?? a;
    const bn = devices.find((d) => d.siteId === b)?.siteName ?? b;
    return an.localeCompare(bn);
  });
  for (const s of activeSites) {
    if (s && !siteChipKeys.includes(s)) siteChipKeys.unshift(s);
  }
  const siteChips = siteChipKeys
    .map((key) => {
      const sample = baseRows.find((d) => d.siteId === key) ?? devices.find((d) => d.siteId === key);
      return {
        key,
        label: sample?.siteName ?? key,
        count: baseRows.filter((d) => d.siteId === key).length,
        pressed: activeSites.length === 1 && activeSites[0] === key,
      };
    })
    .filter((c) => c.count > 0 || c.pressed);
  const toggleSiteChip = (key: string) => {
    const cur = facets.site ?? [];
    if (cur.length === 1 && cur[0] === key) {
      const next = { ...facets };
      delete next.site;
      setFacets(next);
      return;
    }
    setFacets({ ...facets, site: [key] });
  };
  const rows = applyFacets(baseRows, deviceFacets, facets);
  const deviceFiltersActive =
    q.trim().length > 0 ||
    type !== 'all' ||
    issuesFilter !== 'all' ||
    Object.keys(facets).length > 0 ||
    nameFilter !== null ||
    stateFilter !== null;
  const clearDeviceFilters = () => {
    setQ('');
    setType('all');
    setIssuesFilter('all');
    setFacets({});
    setSelectedKeys([]);
    if (nameFilter !== null || stateFilter !== null) {
      const next = new URLSearchParams(searchParams);
      next.delete('names');
      next.delete('state');
      setSearchParams(next, { replace: true });
    }
  };

  /* A saved view snapshots the facet selection, free text, type and the
     issues switch, the column-manager config and the density. The URL deep
     links (?names=, ?state=) are deliberately NOT captured: a filter that
     narrows the estate this hard belongs to the address that explains it. */
  const captureView = (): Omit<SavedView, 'name'> => ({
    filters: { facets, q, type, issuesOnly, issuesFilter },
    tableColumns: tableColumns.devices ?? {},
    density,
  });
  const applyView = (view: SavedView) => {
    const f = view.filters as {
      facets?: unknown;
      q?: unknown;
      type?: unknown;
      issuesOnly?: unknown;
      issuesFilter?: unknown;
    };
    setFacets(sanitizeFacetSelection(f.facets));
    setQ(typeof f.q === 'string' ? f.q : '');
    setType(typeof f.type === 'string' ? f.type : 'all');
    if (f.issuesFilter === '1' || f.issuesFilter === '0' || f.issuesFilter === 'all') {
      setIssuesFilter(f.issuesFilter);
    } else {
      setIssuesOnly(f.issuesOnly === true);
    }
    if (view.tableColumns) setTableColumns('devices', view.tableColumns);
    if (view.density) setDensity(view.density);
  };

  /* The finding named a set; this inventory may no longer hold all of it.
     Showing 10 rows for a link that said 12 needs to say which happened. */
  const namedPresent =
    nameFilter === null ? 0 : nameFilter.filter((name) => devices.some((d) => d.name === name)).length;

  const typeOptions = [{ value: 'all', label: 'All types' }].concat(
    uniq(devices.map((d) => d.type)).map((t) => ({ value: t, label: t })),
  );

  // Reconciliation truth, always from the payload. Every envelope carries it
  // now — live and blend ship the reconciler's real counts, the demo route and
  // this client's offline demo fallback ship the authored estate figures (the
  // 28 fixture rows are a SAMPLE of 418, so counting them would undercount —
  // the prose below says "Fourteen"). Only a payload that carries none at all
  // falls through to a tally of the loaded rows.
  const reconciliation = data.reconciliation;
  const doubleClaimed =
    reconciliation?.doubleClaimed ??
    devices.filter((d) => d.state === 'double-claimed' || (d.claimedBy?.length ?? 0) > 1).length;
  const unclaimed =
    reconciliation?.unclaimed ?? devices.filter((d) => d.licence === 'not in greenlake').length;

  // One lane per plane the payload published lane meta for — INCLUDING a
  // linked plane that reported no inventory at all, which is exactly the gap
  // the lanes view exists to make legible (a lane that vanishes reads as "no
  // such plane"). Planes present in the rows but missing from the lanes map
  // append with the non-asserting fallback meta.
  const present = uniq(devices.map((d) => d.plane));
  const lanePlanes: Plane[] = (Object.keys(data.lanes) as Plane[]).concat(
    present.filter((p) => !(p in data.lanes)),
  );

  // Header subtitle. The authored line states the demo estate's totals (418
  // devices are a 418-row estate the 28 fixtures sample); in live/blend mode
  // it is derived from what actually arrived, never asserted.
  // Linked planes that contributed no inventory at all. The list below is
  // short by whatever they manage, and nothing about a shorter list says so.
  const missing = data.missingInventories ?? [];
  const reporting = lanePlanes.length - missing.length;
  const inventoryCount =
    missing.length > 0
      ? `${reporting} of ${lanePlanes.length} inventor${lanePlanes.length === 1 ? 'y' : 'ies'} reporting`
      : `${lanePlanes.length} inventor${lanePlanes.length === 1 ? 'y' : 'ies'}`;
  const subtitle = isDemo
    ? '418 devices, six inventories, one reconciled list.'
    : `${countOf(devices.length, 'device')}, ${inventoryCount}, one reconciled list.`;

  /* The unified table's column definitions. The keys are stable ids — the
     column manager (View options → show/hide/reorder, header-edge resize)
     persists against them through the global tableColumns setting under the
     'devices' table id, so renaming a label never orphans a saved layout.
     The Clients column exists only while the metrics envelope is loaded, and
     the Actions column only in demo; a persisted config that names a column
     the payload does not currently offer is ignored, not honoured. No column
     carries a tint: nothing on this table has a meaningful threshold, and a
     wash without one would be decoration, not information. */
  const deviceColumns: Array<DataTableColumn<DeviceRow>> = [
    {
      key: 'device',
      title: 'Device',
      hideable: false,
      render: (d) => (
        <button
          type="button"
          onClick={() => navigate(deviceDetailPath({ name: d.name, plane: d.plane, serial: d.serial }))}
          className="nt-mono-link nt-body-sm nt-ta-left"
        >
          {d.name}
        </button>
      ),
    },
    { key: 'model', title: 'Model', render: (d) => displayField(d.model) },
    {
      key: 'type',
      title: 'Type',
      render: (d) => <DeviceTypeBadge type={d.type} model={d.model} name={d.name} showFamily />,
    },
    {
      key: 'site',
      title: 'Site',
      render: (d) => (
        <button
          type="button"
          onClick={() => navigate(`/sites/${encodeURIComponent(d.siteId)}`)}
          className="nt-body-sm nt-btn-plain-primary"
        >
          {displayField(d.siteName)}
        </button>
      ),
    },
    {
      key: 'managedBy',
      title: 'Managed by',
      render: (d) =>
        showPlatformTags ? (
          <div className="nt-chip-wrap nt-chip-wrap--tight">
            {claimantsOf(d).map((p) => (
              <Badge key={p} plane>
                {p}
              </Badge>
            ))}
          </div>
        ) : null,
    },
    {
      key: 'state',
      title: 'State',
      render: (d) => {
        const mark = reconciliationMark(d);
        return (
          <div className="nt-filter-bar nt-gap-4">
            <Badge tone={d.stateTone} dot>
              {d.state}
            </Badge>
            {mark ? <Badge tone={mark.tone}>{mark.label}</Badge> : null}
          </div>
        );
      },
    },
    {
      key: 'firmware',
      title: 'Firmware',
      render: (d) => {
        const fw = displayField(d.firmware);
        // The plane's own firmware verdicts, never prose we invented: a row
        // known to be off the recommended train says so with the target
        // named (warning); the plane's upgrade-state word rides verbatim
        // ('inprogress'), quiet. At-target and unknown get no badge — a
        // quiet cell is the honest rendering of "nothing to act on".
        const behind = d.firmwareTarget !== undefined && !d.firmwareApproved && fw !== 'Not reported';
        return (
          <span className="nt-row-center nt-gap-6 nt-inline-wrap">
            <span
              className={[`nt-mono-11`, fw === 'Not reported' || d.firmwareApproved ? 'nt-tone-secondary' : 'nt-tone-warning'].filter(Boolean).join(" ")}
            >
              {fw}
            </span>
            {behind ? <Badge tone="warning">behind → {d.firmwareTarget}</Badge> : null}
            {d.firmwareUpdate ? <Badge tone="neutral">{d.firmwareUpdate}</Badge> : null}
          </span>
        );
      },
    },
    {
      key: 'licence',
      title: 'Licence',
      render: (d) => (
        <span
          className="nt-hint-muted"
        >
          {displayField(d.licence)}
        </span>
      ),
    },
    ...(metrics !== null
      ? [
          {
            key: 'clients',
            title: 'Clients',
            header: (
              <>
                Clients
                <span
                  className="nt-micro-muted"
                >
                  {metricsWindowLabel(metrics)}
                </span>
              </>
            ),
            render: (d: DeviceRow) => (
              <DeviceClientsSpark metrics={metrics} name={d.name} compact={density === 'compact'} />
            ),
          },
        ]
      : []),
    ...(isDemo
      ? [
          {
            key: 'actions',
            title: 'Actions',
            header: '',
            render: (d: DeviceRow) => (
              <button
                type="button"
                onClick={() => void hideDevice(d.name)}
                aria-label={`Hide ${d.name} from the demo inventory`}
                className="nt-mono-label nt-btn-plain"
              >
                hide
              </button>
            ),
          },
        ]
      : []),
  ];

  const diagnosticsCue =
    actionCue === 'diagnostics' ? paletteActionCue('diagnostics') : null;

  return (
    <div className="nt-stack nt-recon-reveal nt-devices-shell nt-section-panel">
      <ScreenHeader
        overline="Inventory / Devices"
        title="Devices"
        subtitle={subtitle}
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · fleet
            </span>
            {!isDemo ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  /* Prefer the live address bar (filter write-back keeps it
                     complete); fall back to building from state if empty. */
                  const qs =
                    window.location.search ||
                    (() => {
                      const next = new URLSearchParams();
                      if (q.trim()) next.set('q', q.trim());
                      if (type !== 'all') next.set('type', type);
                      if (issuesFilter !== 'all') next.set('issues', issuesFilter);
                      const planes = facets.plane ?? [];
                      if (planes.length > 0) next.set('plane', planes.join(','));
                      const sites = facets.site ?? [];
                      if (sites.length > 0) next.set('site', sites.join(','));
                      if (nameFilter) next.set('names', nameFilter.join('\n'));
                      if (stateFilter) next.set('state', stateFilter);
                      const s = next.toString();
                      return s ? `?${s}` : '';
                    })();
                  const url = `${window.location.origin}${window.location.pathname}${qs}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('View link copied', {
                      description: qs || 'unfiltered devices list',
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
                const n = exportTableCsv(
                  'devices.csv',
                  ['name', 'type', 'model', 'site', 'plane', 'state', 'firmware', 'serial', 'mac', 'ip', 'licence'],
                  rows.map((d) => [
                    d.name,
                    d.type,
                    d.model,
                    d.siteName,
                    d.plane,
                    d.state,
                    d.firmware,
                    d.serial ?? '',
                    d.mac ?? '',
                    d.ip ?? '',
                    d.licence,
                  ]),
                );
                toast(`Exported ${countOf(n, 'device')}`, {
                  description: 'devices.csv — rows currently in view.',
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
                    if (serverQ) qs.set('q', serverQ);
                    if (serverType) qs.set('type', serverType);
                    if (serverIssues) qs.set('issues', serverIssues);
                    if (serverPlane) qs.set('plane', serverPlane);
                    if (serverSite) qs.set('site', serverSite);
                    if (serverState) qs.set('state', serverState);
                    const suffix = qs.toString() ? `?${qs}` : '';
                    const res = await downloadApiCsv(`/api/devices/export${suffix}`, 'devices.csv');
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description: 'devices.csv — filtered portal inventory export.',
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
            <SegmentedControl
              options={VIEW_OPTIONS}
              value={inventoryView}
              onValueChange={(v) => setInventoryView(v as InventoryView)}
              ariaLabel="Inventory presentation"
            />
          </>
        }
      />
      <div className="nt-plane-theater" role="note">NightDesk · fleet theater · health owns hue · monochrome planes</div>

      {typeChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Device type">
          <span className="nt-chip-row__label">Type</span>
          {typeChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setType(c.key === type ? 'all' : c.key)}
              className={type === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={type === c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {issuesChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Device issues">
          <span className="nt-chip-row__label">Issues</span>
          {issuesChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setIssuesFilter(issuesFilter === c.key ? 'all' : c.key)}
              className={
                issuesFilter === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={issuesFilter === c.key}
              data-issues={c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {stateChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Device state">
          <span className="nt-chip-row__label">State</span>
          {stateChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => toggleStateChip(c.key)}
              className={
                c.pressed ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={c.pressed}
              data-state={c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {planeChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Device plane">
          <span className="nt-chip-row__label">Plane</span>
          {planeChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => togglePlaneChip(c.key)}
              className={
                c.pressed ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={c.pressed}
              data-plane={c.key}
            >
              <Badge plane>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {siteChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Device site">
          <span className="nt-chip-row__label">Site</span>
          {siteChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => toggleSiteChip(c.key)}
              className={
                c.pressed ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={c.pressed}
              data-site={c.key}
            >
              <Badge tone="neutral">{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <VisualReferencePanel target={{ kind: 'service', id: 'devices' }} editable={false} />
      <ConfigRecommendationsPanel title="Device recommendations" limit={6} />

      {diagnosticsCue ? (
        <Alert
          tone="info"
          title={diagnosticsCue.title}
          dismissible
          onDismiss={() => setActionCue(null)}
        >
          <span className="nt-body-sm">{diagnosticsCue.body}</span>
        </Alert>
      ) : null}

      <div className="nt-filter-bar nt-sticky-filters">
        <div className="nt-filter-field nt-filter-field--xl nt-w-250">
          <Input
            size="sm"
            mono
            placeholder="name, model, serial, ip…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter devices"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--sm">
          <Select
            options={typeOptions}
            value={type}
            onValueChange={setType}
            size="sm"
            aria-label="Device type"
          />
        </div>
        <FacetFilter facets={deviceFacets} rows={baseRows} selection={facets} onChange={setFacets} />
        <Switch
          label="Reconciliation issues only"
          size="sm"
          checked={issuesOnly}
          onCheckedChange={setIssuesOnly}
        />
        {nameFilter !== null ? (
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('names');
              setSearchParams(next, { replace: true });
            }}
            title={nameFilter.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {namedPresent === nameFilter.length
              ? `${nameFilter.length} named devices`
              : `${namedPresent} of ${nameFilter.length} named devices — ${nameFilter.length - namedPresent} not in this inventory`}
            {' — clear'}
          </button>
        ) : null}
        {/* A state slice has no Select of its own (states are the feed's free
            vocabulary, not a fixed option list), so the chip is what keeps the
            filter that is hiding rows visible and clearable — the same job the
            names chip does beside it. */}
        {stateFilter !== null ? (
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('state');
              setSearchParams(next, { replace: true });
            }}
            className="nt-chip nt-chip--active"
          >
            {`state: ${stateFilter} — clear`}
          </button>
        ) : null}
        {isDemo && hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => void restoreHidden()}
            className="nt-mono-link"
          >
            {hiddenCount} hidden — restore
          </button>
        ) : null}
        {inventoryView === 'Unified table' ? (
          <>
            <TableViewOptions
              columns={deviceColumns}
              config={tableColumns.devices ?? {}}
              onChange={(config) => setTableColumns('devices', config)}
            />
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </>
        ) : null}
        <SavedViews
          views={savedViews.devices ?? []}
          capture={captureView}
          onApply={applyView}
          onChange={(views) => setSavedViews('devices', views)}
        />
        <span className="nt-filter-bar__count">
          {rows.length} of {devices.length} indexed{isDemo ? ' · 418 total incl. bulk APs' : ''}
        </span>
      </div>

      {missing.length > 0 ? (
        <Alert
          tone="warning"
          title={`${missing.length} linked inventor${missing.length === 1 ? 'y is' : 'ies are'} not represented below: ${missing.join(', ')}`}
        >
          <span className="nt-fs-13">
            These planes are linked but their device read has not come back, so whatever they manage is missing from
            this list and from the reconciliation counts. This is not an empty inventory — it is an unread one. Check
            them in Connected systems before treating this list as the estate.
          </span>
        </Alert>
      ) : null}

      {doubleClaimed > 0 || unclaimed > 0 ? (
        <Alert
          tone="warning"
          title={`Reconciliation: ${countOf(doubleClaimed, 'device')} claimed by two inventories, ${unclaimed} by none`}
        >
          <span className="nt-fs-13">
            {isDemo
              ? 'sw-riv-2, ap-riv-01 and ap-riv-06 exist in both Central Classic and the local collector with different firmware records. Fourteen Warehouse switches appear in no cloud plane at all — they are only visible over SSH.'
              : 'These counts come from the current live inventory reconciliation. Open an affected device to inspect its reporting planes and identity evidence.'}
          </span>
        </Alert>
      ) : null}

      {inventoryView === 'Unified table' ? (
        <>
          <DataTable
            ariaLabel="Devices"
            density={density}
            columns={deviceColumns}
            rows={rows}
            rowKey={(d) => `${d.name}:${d.serial ?? d.plane}`}
            columnsConfig={tableColumns.devices}
            onColumnsConfigChange={(config) => setTableColumns('devices', config)}
            onRowActivate={(d) => navigate(deviceDetailPath({ name: d.name, plane: d.plane, serial: d.serial }))}
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            rowTone={(d) => d.stateTone}
          />
          {selectedKeys.length > 0 ? (
            <div className="nt-configure-bulk-bar nt-bulk-glass" role="region" aria-label="Device selection actions">
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export or share only the devices you marked — full list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((d) => selected.has(`${d.name}:${d.serial ?? d.plane}`));
                    if (picked.length === 0) {
                      toast('No selected devices still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'devices-selected.csv',
                      ['name', 'type', 'model', 'site', 'plane', 'state', 'firmware', 'serial', 'mac', 'ip', 'licence'],
                      picked.map((d) => [
                        d.name,
                        d.type,
                        d.model,
                        d.siteName,
                        d.plane,
                        d.state,
                        d.firmware,
                        d.serial ?? '',
                        d.mac ?? '',
                        d.ip ?? '',
                        d.licence,
                      ]),
                    );
                    toast(`Exported ${countOf(n, 'selected device')}`, {
                      description: 'devices-selected.csv — inventory fields only.',
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
                      const picked = rows.filter((d) => selected.has(`${d.name}:${d.serial ?? d.plane}`));
                      if (picked.length === 0) {
                        toast('No selected devices still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      /* Reuse the Compliance ?names= deep link so a shared
                         selection reopens the same named set on refresh. */
                      const next = new URLSearchParams(searchParams);
                      next.set('names', picked.map((d) => d.name).join('\n'));
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${picked.length} named device${picked.length === 1 ? '' : 's'} · names=`,
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((d) => selected.has(`${d.name}:${d.serial ?? d.plane}`));
                      if (picked.length === 0) {
                        toast('No selected devices still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const serials = picked
                        .map((d) => (d.serial ?? '').trim())
                        .filter(Boolean);
                      if (serials.length === 0) {
                        toast('No serials on the selected devices', {
                          description: 'Those rows did not publish a serial — export CSV for names instead.',
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
                <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                  Clear
                </Button>
              </span>
            </div>
          ) : null}
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing matches that filter"
              description="Loosen the search or the type filter and facets to see the rest of the inventory."
            >
              {devices.length > 0 && deviceFiltersActive ? (
                <Button variant="secondary" size="sm" onClick={clearDeviceFilters}>
                  Clear filters
                </Button>
              ) : null}
            </EmptyState>
          ) : null}
          {deviceHasMore || devicePageTotal != null ? (
            <div className="nt-filter-bar">
              {devicePageTotal != null ? (
                <span className="nt-mono-label">
                  Loaded {data.devices.length} of {devicePageTotal}
                </span>
              ) : null}
              {deviceHasMore ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loadingMoreDevices}
                  onClick={() => loadMoreDevicesRef.current()}
                >
                  {loadingMoreDevices ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div
          className="nt-fleet-grid"
        >
          {lanePlanes.map((p) => {
            const meta = data.lanes[p] ?? FALLBACK_LANE;
            const inLane = rows.filter((d) => d.plane === p);
            // "Nothing here" has two different meanings and the lane must not
            // conflate them: the plane reported no inventory at all, or the
            // local filters excluded the rows it did report.
            const planeReportedNothing = !present.includes(p);
            return (
              <div key={p} className="nt-stack nt-gap-10 nt-min-w-0">
                <div
                  className="nt-fleet-lane nt-lane-mark"
                >
                  <div
                    className="nt-fleet-lane__head"
                  >
                    <span
                      className="nt-mono-label nt-text-pri-12 nt-lh-inherit"
                    >
                      {p}
                    </span>
                    <span
                      className="nt-hint-muted"
                    >
                      {inLane.length} shown
                    </span>
                  </div>
                  <div className="nt-row nt-gap-6">
                    <Badge tone={meta.tone} dot>
                      {meta.sync}
                    </Badge>
                    <span
                      className="nt-hint-muted"
                    >
                      {meta.note}
                    </span>
                  </div>
                </div>
                <div
                  className="nt-stack nt-fleet-list nt-stack-col"
                >
                  {inLane.map((d) => (
                    <button
                      key={`${d.name}:${d.serial ?? d.plane}`}
                      type="button"
                      className="nt-rowlink nt-device-lane-row nt-device-nav-btn"
                      data-tone={d.stateTone}
                      onClick={() => navigate(deviceDetailPath({ name: d.name, plane: d.plane, serial: d.serial }))}
                    >
                      <div className="nt-row nt-gap-6">
                        <span
                          className="nt-ellipsis nt-mono-11 nt-text-primary-flex"
                        >
                          {d.name}
                        </span>
                        <span
                          className="nt-dot-6" data-tone={d.stateTone}
                        />
                      </div>
                      <span
                        className="nt-body-sm nt-ellipsis nt-hint-muted"
                      >
                        {displayField(d.model)}
                      </span>
                      <span
                        className="nt-hint-muted nt-ellipsis"
                      >
                        {displayField(d.siteName)}
                      </span>
                    </button>
                  ))}
                  {inLane.length === 0 ? (
                    <div
                      className="nt-empty-lane"
                    >
                      {planeReportedNothing
                        ? 'No inventory reported by this plane.'
                        : 'Nothing in this lane matches the filter.'}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
