/**
 * web/src/screens/Devices.tsx — unified inventory with two presentations.
 * High-fidelity port of design/NtDevices.dc.html: header SegmentedControl
 * ("Unified table" | "Platform lanes") bound to the global inventoryView
 * setting (the prototype's local-override bug is not carried over), filter
 * row (search, type Select, FacetFilter popovers — plane, state, site, each a
 * checklist with live counts, OR-within / AND-across — "Reconciliation issues
 * only" Switch, saved-views dropdown, mono `N of M indexed` count), warning
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
 * finding's set) and ?state= (an availability count's state slice) — each
 * read straight off the URL and each showing a clearable chip while it
 * narrows the list.
 *
 * The unified table is the nightdesk DataTable reference integration: the
 * column manager (View options dropdown + header-edge resize) persists its
 * controlled config through SettingsContext under the 'devices' table id,
 * the rows are a keyboard grid (j/↓ k/↑ move, Enter/→ opens the device, x
 * selects, Esc clears — '?' lists them), and no column tints because nothing
 * here has a meaningful threshold. The rollout guide for the other screens
 * lives in DataTable.tsx's module comment. Saved views (the Views dropdown)
 * capture the facet selection, free text, type and issues-only switch, the
 * column config and the density, named and persisted through SettingsContext
 * under the 'devices' screen id; the URL deep links are NOT captured — a
 * filter that narrows this hard belongs to the address that explains it.
 *
 * Data: getDevices() — live /api/devices when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  DATATABLE_ROW_SHORTCUTS,
  DataTable,
  EmptyState,
  Input,
  KeyboardShortcuts,
  SegmentedControl,
  Select,
  Sparkline,
  Spinner,
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
import { UNKNOWN_LANE_META, countOf } from '@hpe/shared';
import type { DeviceRow, MetricsHistoryEnvelope, Plane, Tone } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import '../app/app.css';

function displayField(value: string): string {
  const normal = value.trim().toLowerCase();
  return !value || normal === '—' || normal === 'unknown' ? 'Not reported' : value;
}

const VIEW_OPTIONS = [
  { value: 'Unified table', label: 'Unified table' },
  { value: 'Platform lanes', label: 'Platform lanes' },
];

/** Lane-row state dot per Badge tone (prototype `dotFor` map). */
const DOT_COLORS: Record<Tone, string> = {
  success: 'var(--nd-success)',
  warning: 'var(--nd-warning)',
  danger: 'var(--nd-danger)',
  info: 'var(--nd-info)',
  neutral: 'var(--nd-border-strong)',
  accent: 'var(--nd-accent)',
};

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
  const muted = { fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)', color: 'var(--nd-text-muted)' } as const;
  const series = metrics.deviceClients[name] ?? [];
  const latest = series.length > 0 ? series[series.length - 1]!.v : null;
  if (series.length >= 2 && latest !== null) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Sparkline
          points={series}
          width={72}
          height={compact ? 14 : 18}
          label={`${latest} attached client${latest === 1 ? '' : 's'} · ${windowLabel}`}
        />
        <span style={{ ...muted, color: 'var(--nd-text-secondary)' }}>{latest}</span>
      </span>
    );
  }
  if (series.length === 1) {
    return (
      <span style={muted} title={`one sample so far · ${windowLabel}`}>
        1 sample
      </span>
    );
  }
  return (
    <span style={muted} title="no attached-client samples for this device">
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
  /* Row selection for the unified table's keyboard grid. Nothing on this
   * screen consumes the selection yet — it is the controlled-props reference
   * for the change-queue bulk-actions work, which will. */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  /* Faceted filtering (plane / state / site) — OR within a facet, AND across
   * facets, composed with the search, type Select, switch and URL filters.
   * The ?plane= deep link seeds the plane facet. */
  const [facets, setFacets] = useState<FacetSelection>(() => {
    const p = planeFilterForParam(searchParams.get('plane'));
    const initial: FacetSelection = p === 'all' ? {} : { plane: [p] };
    return initial;
  });
  const [issuesOnly, setIssuesOnly] = useState(false);
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
    const fresh = await getDevices();
    setData(fresh);
    toast('Hidden demo devices restored', { tone: 'success' });
  };

  /* The lanes view stamps each plane's freshness from this payload, so a NOC
     tab must not sit on a mount-time snapshot: poll on the settings cadence,
     the same pattern Overview.tsx runs. One fetch at a time — a slow response
     never stacks up behind the interval; fixture reads poll harmlessly. */
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = () => {
      if (inFlight) return;
      inFlight = true;
      void getDevices().then((d) => {
        if (live) setData(d);
      });
      void getMetricsHistory()
        .then((m) => {
          if (live) setMetrics(m);
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

  /* Deep link: /devices?plane=<registryId> (from the Systems plane drawer).
     Applied when the URL changes while the screen is mounted — state adjusted
     during render rather than an effect that commits the stale filter first. */
  const [prevParams, setPrevParams] = useState(searchParams);
  if (prevParams !== searchParams) {
    setPrevParams(searchParams);
    const pp = searchParams.get('plane');
    if (pp !== null) {
      const p = planeFilterForParam(pp);
      setFacets((cur) => {
        const next = { ...cur };
        if (p === 'all') delete next.plane;
        else next.plane = [p];
        return next;
      });
    }
  }

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
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
  const baseRows = devices.filter(
    (d) =>
      (type === 'all' || d.type === type) &&
      (!issuesOnly || d.reconciliationIssue) &&
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
  const rows = applyFacets(baseRows, deviceFacets, facets);

  /* A saved view snapshots the facet selection, free text, type and the
     issues switch, the column-manager config and the density. The URL deep
     links (?names=, ?state=) are deliberately NOT captured: a filter that
     narrows the estate this hard belongs to the address that explains it. */
  const captureView = (): Omit<SavedView, 'name'> => ({
    filters: { facets, q, type, issuesOnly },
    tableColumns: tableColumns.devices ?? {},
    density,
  });
  const applyView = (view: SavedView) => {
    const f = view.filters as { facets?: unknown; q?: unknown; type?: unknown; issuesOnly?: unknown };
    setFacets(sanitizeFacetSelection(f.facets));
    setQ(typeof f.q === 'string' ? f.q : '');
    setType(typeof f.type === 'string' ? f.type : 'all');
    setIssuesOnly(f.issuesOnly === true);
    if (view.tableColumns) setTableColumns('devices', view.tableColumns);
    if (view.density) setDensity(view.density);
  };

  /* The finding named a set; this inventory may no longer hold all of it.
     Showing 10 rows for a link that said 12 needs to say which happened. */
  const namedPresent =
    nameFilter === null ? 0 : nameFilter.filter((name) => devices.some((d) => d.name === name)).length;

  const uniq = <T,>(xs: T[]): T[] => xs.filter((v, i, a) => a.indexOf(v) === i);
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
      ),
    },
    { key: 'model', title: 'Model', render: (d) => displayField(d.model) },
    {
      key: 'type',
      title: 'Type',
      render: (d) => (
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10.5,
            color: 'var(--nd-text-muted)',
            textTransform: 'uppercase',
          }}
        >
          {d.type}
        </span>
      ),
    },
    {
      key: 'site',
      title: 'Site',
      render: (d) => (
        <button
          type="button"
          onClick={() => navigate(`/sites/${encodeURIComponent(d.siteId)}`)}
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
          {displayField(d.siteName)}
        </button>
      ),
    },
    {
      key: 'managedBy',
      title: 'Managed by',
      render: (d) =>
        showPlatformTags ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {claimantsOf(d).map((p) => (
              <Badge key={p} tone={p === d.plane ? d.planeTone : 'neutral'}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color:
                  fw === 'Not reported' || d.firmwareApproved
                    ? 'var(--nd-text-secondary)'
                    : 'var(--nd-warning)',
              }}
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
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10.5,
            color: 'var(--nd-text-muted)',
          }}
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
                  style={{
                    display: 'block',
                    fontSize: 9,
                    letterSpacing: '0.02em',
                    textTransform: 'none',
                    color: 'var(--nd-text-muted)',
                  }}
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
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--nd-text-muted)',
                }}
              >
                hide
              </button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Inventory / Devices"
        title="Devices"
        subtitle={subtitle}
        actions={
          <SegmentedControl
            options={VIEW_OPTIONS}
            value={inventoryView}
            onValueChange={(v) => setInventoryView(v as InventoryView)}
            ariaLabel="Inventory presentation"
          />
        }
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 250 }}>
          <Input
            size="sm"
            mono
            placeholder="name, model, serial, ip…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter devices"
          />
        </div>
        <div style={{ width: 140 }}>
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
            style={{
              background: 'none',
              border: '1px solid var(--nd-border)',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-accent-text)',
            }}
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
            style={{
              background: 'none',
              border: '1px solid var(--nd-border)',
              borderRadius: 4,
              padding: '2px 8px',
              cursor: 'pointer',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-accent-text)',
            }}
          >
            {`state: ${stateFilter} — clear`}
          </button>
        ) : null}
        {isDemo && hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => void restoreHidden()}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-accent-text)',
            }}
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
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-muted)',
          }}
        >
          {rows.length} of {devices.length} indexed{isDemo ? ' · 418 total incl. bulk APs' : ''}
        </span>
      </div>

      {missing.length > 0 ? (
        <Alert
          tone="warning"
          title={`${missing.length} linked inventor${missing.length === 1 ? 'y is' : 'ies are'} not represented below: ${missing.join(', ')}`}
        >
          <span style={{ fontSize: 13 }}>
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
          <span style={{ fontSize: 13 }}>
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
          />
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing matches that filter"
              description="Loosen the search or the type filter and facets to see the rest of the inventory."
            />
          ) : null}
        </>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(196px, 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
          {lanePlanes.map((p) => {
            const meta = data.lanes[p] ?? FALLBACK_LANE;
            const inLane = rows.filter((d) => d.plane === p);
            // "Nothing here" has two different meanings and the lane must not
            // conflate them: the plane reported no inventory at all, or the
            // local filters excluded the rows it did report.
            const planeReportedNothing = !present.includes(p);
            return (
              <div key={p} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    paddingBottom: 9,
                    borderBottom: `2px solid ${meta.mark}`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-11)',
                        letterSpacing: '.1em',
                        textTransform: 'uppercase',
                        color: 'var(--nd-text-primary)',
                      }}
                    >
                      {p}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-11)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {inLane.length} shown
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Badge tone={meta.tone} dot>
                      {meta.sync}
                    </Badge>
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-10)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {meta.note}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    maxHeight: 520,
                    overflow: 'auto',
                  }}
                >
                  {inLane.map((d) => (
                    <button
                      key={`${d.name}:${d.serial ?? d.plane}`}
                      type="button"
                      className="nt-rowlink"
                      onClick={() => navigate(deviceDetailPath({ name: d.name, plane: d.plane, serial: d.serial }))}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        alignItems: 'stretch',
                        textAlign: 'left',
                        background: 'none',
                        border: 'none',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                        borderLeft: '2px solid transparent',
                        padding: '9px 8px',
                        cursor: 'pointer',
                        width: '100%',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 11.5,
                            color: 'var(--nd-text-primary)',
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {d.name}
                        </span>
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 99,
                            background: DOT_COLORS[d.stateTone],
                            flex: '0 0 6px',
                          }}
                        />
                      </div>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-body)',
                          fontSize: 'var(--nd-text-11)',
                          color: 'var(--nd-text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {displayField(d.model)}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 'var(--nd-text-10)',
                          color: 'var(--nd-text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {displayField(d.siteName)}
                      </span>
                    </button>
                  ))}
                  {inLane.length === 0 ? (
                    <div
                      style={{
                        padding: '12px 4px',
                        fontFamily: 'var(--nd-font-display)',
                        fontStyle: 'italic',
                        fontSize: 'var(--nd-text-12)',
                        color: 'var(--nd-text-muted)',
                      }}
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
