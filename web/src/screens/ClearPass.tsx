/**
 * web/src/screens/ClearPass.tsx — the endpoint policy screen.
 *
 * ClearPass owns two things the rest of the portal only borrows a slice of:
 * the endpoint repository (profiling — MAC, IP, hostname, category, OS,
 * enforcement profile) and the RADIUS auth feed (already the dedicated
 * /auth-events screen). This screen puts the repository front and centre with
 * a filterable table, and keeps a compact tail of the same auth feed so an
 * operator does not have to leave the plane's screen to see why an endpoint
 * was just quarantined.
 *
 * Behind those two, a SegmentedControl tab strip holds the CPPM's policy
 * inventories: the NADs that authenticate to it, its auth sources, roles,
 * enforcement policies→profiles, local users (whitelisted identity fields
 * only — no password material exists in this payload), and the service
 * definitions themselves (enabled state, template, hit count, match rules —
 * whitelisted the same way; nothing in a service row is credential
 * material). Deep links: `?tab=` opens a named strip (default endpoints omits
 * the param); endpoint `q` / `status` / `category` (a **Status** chip row
 * counts over the q+category universe and toggles the same `?status=` as the
 * Select; a **Category** chip row counts over q+status and toggles the same
 * `?category=` — Loop 142) and services `enabled` (an **Enabled** chip row counts
 * over loaded q and toggles the same `?enabled=` — Loop 149)
 * write back with the tab so **Copy filter link** shares the same view.
 * Services also reuses `q` and server CSV uses `part=services`. Endpoint
 * multi-select raises **Export selected**, **Copy MACs** (unique newline-joined
 * inventory MACs for NAC paste — Devices **Copy serials** pattern), **Copy names**
 * (unique newline-joined hostnames when MACs are sparse — Clients / Auth events
 * pattern; Loop 228), **Copy selection link** (`?macs=` of unique inventory MACs —
 * Clients `?macs=` pattern; clearable chip while active; Loop 175), and Clear
 * (Loop 162).
 * Services multi-select raises **Export selected**, **Copy names**
 * (unique newline-joined service names for policy hand-offs — Devices **Copy
 * serials** pattern), **Copy selection link** (`?services=` of service ids with
 * `tab=services` — Sites `?ids=` pattern; clearable chip while active;
 * Loop 181), and Clear (Loop 174). Selection-empty `?services=` offers **Clear
 * selection filter** (Loop 213). Services filtered empties (q / enabled, not
 * selection) offer **Clear filters** (Loop 222). Services table carries keyboard
 * shortcuts help (`?` / DATATABLE_ROW_SHORTCUTS — Loop 222). Selection-empty
 * endpoints `?macs=` offers **Clear selection filter** (Loop 219). Header **LIVE**
 * stamps pure live and clearpass blend feeds alike (Loop 168 — pure live used to
 * omit blend honesty). Endpoints table carries keyboard shortcuts help
 * (`?` / DATATABLE_ROW_SHORTCUTS — Loop 195).
 * Each collection rides the envelope only when the plane reported it, so every
 * tab keeps the three states distinct: reported rows / a real empty answer /
 * "not reported by this CPPM". Services populate wherever the box answers
 * /api/config/service (6.11+) or the legacy /api/service — the demo estate's
 * 6.11 CPPM included; device groups stay the collection that reads "not
 * available on this CPPM" in both modes. A service row opens a detail drawer
 * with the full definition (summary, match rules, authentication,
 * authorization, enforcement, options), read on demand from GET
 * /api/clearpass/services/:id — the one per-service read this screen spends,
 * TTL-cached and budget-gated on the server, never polled.
 *
 * The Endpoints and Local users tabs also WRITE — the only two CPPM datasets
 * the portal touches (policy stays in ClearPass): 'Register endpoint' and a
 * per-row edit (status + operator note), 'Add local user' and a per-row edit
 * (display name, role from the reported roles, enabled, and a write-only
 * password that is never displayed, echoed, or read back). Every write goes
 * through the same reviewed drawer the SSID editor set — an exact summary of
 * what will be written, an explicit review checkbox standing in for a
 * ticket, and the server's apply→verify→audit result shown verbatim. Demo
 * mode applies the write to the fixture world the screen is already showing
 * and says plainly that nothing left the portal; live mode re-fetches the
 * screen after a landed write and says so when the server's cache refresh
 * could not confirm the lists are current.
 *
 * Data: getClearPass() — live /api/clearpass when the server is up, fixtures
 * otherwise (see web/src/api/screens.ts).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  PageSkeleton,
  Skeleton,
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  EmptyState,
  FormField,
  Input,
  SectionHeader,
  SegmentedControl,
  Select,
  Switch,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  KeyboardShortcuts,
  TableViewOptions,
  Textarea,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { namesFilterForParam } from '../app/nav';
import { getClearPass, getClearPassServiceDetail } from '../api/client';
import type { ClearPassData, ClearPassServiceDetailResult } from '../api/client';
import {
  registerClearPassEndpoint,
  updateClearPassEndpoint,
  createClearPassLocalUser,
  updateClearPassLocalUser,
  getClearPassEndpointPage,
} from '../api/clearpass';
import type { ClearPassEndpointPage } from '../api/clearpass';
import { isApiError } from '../api/core';
import { getSystemsState, type SystemsState } from '../api/systems';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { useSettings } from '../app/SettingsContext';
import { useLabConfigMode } from '../hooks/useLabConfigMode';
import { hhmmssLocal, hhmmLocal, formatCount, countOf, normalizeMac, detailState } from '@hpe/shared';
import {
  CLEARPASS_ENDPOINT_STATUSES,
  type ClearPassAuthSourceRow,
  type ClearPassDeviceGroupRow,
  type ClearPassEndpointRegisterForm,
  type ClearPassEndpointStatus,
  type ClearPassEndpointUpdateForm,
  type ClearPassEnforcementPolicyRow,
  type ClearPassEnforcementProfileRow,
  type ClearPassLocalUserCreateForm,
  type ClearPassLocalUserRow,
  type ClearPassLocalUserUpdateForm,
  type ClearPassNetworkDeviceRow,
  type ClearPassRoleRow,
  type ClearPassServiceDetailLive,
  type ClearPassServiceRow,
  type ClearPassWriteResult,
  type EndpointRow,
  type StatDef,
  type Tone,
} from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';

type ClearPassTab = 'endpoints' | 'auth' | 'network' | 'sources' | 'roles' | 'enforcement' | 'users' | 'services';

const CLEARPASS_TABS = [
  'endpoints',
  'auth',
  'network',
  'sources',
  'roles',
  'enforcement',
  'users',
  'services',
] as const satisfies readonly ClearPassTab[];

const TAB_OPTIONS: Array<{ value: ClearPassTab; label: string }> = [
  { value: 'endpoints', label: 'Endpoints' },
  { value: 'auth', label: 'Auth events' },
  { value: 'network', label: 'Network devices' },
  { value: 'sources', label: 'Auth sources' },
  { value: 'roles', label: 'Roles' },
  { value: 'enforcement', label: 'Enforcement' },
  { value: 'users', label: 'Local users' },
  { value: 'services', label: 'Services' },
];

function parseClearPassTab(raw: string | null | undefined): ClearPassTab | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return (CLEARPASS_TABS as readonly string[]).includes(key) ? (key as ClearPassTab) : null;
}

const STATUS_TONE: Record<string, Tone> = {
  Known: 'success',
  Unknown: 'warning',
  Disabled: 'neutral',
};

function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? 'neutral';
}

function uniq(values: Array<string | null>): string[] {
  return values.filter((v): v is string => v !== null).filter((v, i, a) => a.indexOf(v) === i);
}

export default function ClearPass() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { density } = useSettings();
  const { lab } = useLabConfigMode();
  const [data, setData] = useState<ClearPassData | null>(null);
  const [endpointPage, setEndpointPage] = useState<ClearPassEndpointPage | null>(null);
  const [systemsState, setSystemsState] = useState<SystemsState | null>(null);
  const [tab, setTab] = useState<ClearPassTab>(
    () => parseClearPassTab(searchParams.get('tab')) ?? 'endpoints',
  );
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [status, setStatus] = useState(() => searchParams.get('status') ?? 'all');
  const [category, setCategory] = useState(() => searchParams.get('category') ?? 'all');
  const [enabled, setEnabled] = useState(() => {
    const raw = (searchParams.get('enabled') ?? '').trim().toLowerCase();
    /* Normalise queryFlag tokens (yes/on/true → 1; no/off/false → 0). */
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return '1';
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return '0';
    return 'all';
  });
  const dataRequestSeqRef = useRef(0);
  const dataMountedRef = useRef(false);
  const endpointPageRequestSeqRef = useRef(0);
  const endpointPageMountedRef = useRef(false);

  const requestData = async (): Promise<void> => {
    const seq = ++dataRequestSeqRef.current;
    const next = await getClearPass();
    if (dataMountedRef.current && seq === dataRequestSeqRef.current) setData(next);
  };

  const requestEndpointPage = async (offset: number, limit = 50): Promise<void> => {
    const seq = ++endpointPageRequestSeqRef.current;
    const page = await getClearPassEndpointPage(offset, limit, {
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(status !== 'all' ? { status } : {}),
      ...(category !== 'all' ? { category } : {}),
    });
    if (endpointPageMountedRef.current && seq === endpointPageRequestSeqRef.current) setEndpointPage(page);
  };

  /* Keep ?tab= / endpoint+services filters aligned so Copy filter link and refresh reopen the same strip.
   * Selection deep-links `macs=` / `services=` are URL-owned (Copy selection link) and preserved here. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (tab !== 'endpoints') next.set('tab', tab);
    else next.delete('tab');
    const qTrim = q.trim();
    if (qTrim) next.set('q', qTrim);
    else next.delete('q');
    if (status !== 'all') next.set('status', status);
    else next.delete('status');
    if (category !== 'all') next.set('category', category);
    else next.delete('category');
    if (enabled !== 'all') next.set('enabled', enabled);
    else next.delete('enabled');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [tab, q, status, category, enabled, searchParams, setSearchParams]);

  useEffect(() => {
    dataMountedRef.current = true;
    endpointPageMountedRef.current = true;
    void requestData();
    void getSystemsState().then((state) => {
      if (dataMountedRef.current) setSystemsState(state);
    });
    return () => {
      dataMountedRef.current = false;
      dataRequestSeqRef.current += 1;
      endpointPageMountedRef.current = false;
      endpointPageRequestSeqRef.current += 1;
    };
  }, []);

  /* Endpoint page is on-demand and filter-aware: reload page 0 whenever the
     filter strip changes so Next/Prev continue the same q/status/category. */
  useEffect(() => {
    if (!endpointPageMountedRef.current) return;
    void requestEndpointPage(0, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional filter keys only
  }, [q, status, category]);

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  return (
    <ClearPassView
      data={data}
      navigate={navigate}
      density={density}
      lab={lab}
      tab={tab}
      setTab={setTab}
      q={q}
      setQ={setQ}
      status={status}
      setStatus={setStatus}
      category={category}
      setCategory={setCategory}
      enabled={enabled}
      setEnabled={setEnabled}
      endpointPage={endpointPage}
      clearpassHealth={systemsState?.planes?.clearpass?.health ?? null}
      clearpassNote={systemsState?.planes?.clearpass?.note ?? null}
      loadEndpointPage={(offset) => requestEndpointPage(offset, 50)}
      refreshEndpointPage={async () => {
        const page = endpointPage;
        await requestEndpointPage(page?.offset ?? 0, page?.limit ?? 50);
      }}
      reload={requestData}
      mergeDemo={(fn) => setData((current) => (current ? fn(current) : current))}
      mergeDemoEndpointPage={(fn) => setEndpointPage((current) => (current ? fn(current) : current))}
    />
  );
}

/** Client filter for the Services tab — mirrors server filterClearPassServiceRows. */
export function filterServicesForView(
  services: ClearPassServiceRow[] | undefined,
  q: string,
  enabled: string,
): ClearPassServiceRow[] | undefined {
  if (services === undefined) return undefined;
  const needle = q.trim().toLowerCase();
  const er = enabled.trim().toLowerCase();
  const enabledWant =
    er === '1' || er === 'true' || er === 'yes' || er === 'on'
      ? true
      : er === '0' || er === 'false' || er === 'no' || er === 'off'
        ? false
        : null;
  if (!needle && enabledWant === null) return services;
  return services.filter((row) => {
    if (enabledWant !== null) {
      if (row.enabled !== true && row.enabled !== false) return false;
      if (row.enabled !== enabledWant) return false;
    }
    if (needle) {
      const hay = [
        row.id,
        row.name,
        row.type,
        row.description,
        row.template,
        row.rulesSummary,
        ...(row.authSources ?? []),
      ]
        .map((v) => String(v ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}


/** Which reviewed write drawer is open (null = none). */
type WriteDrawerState =
  | { kind: 'register' }
  | { kind: 'editEndpoint'; row: EndpointRow }
  | { kind: 'createUser' }
  | { kind: 'editUser'; row: ClearPassLocalUserRow }
  | null;

/** A local projection of a static inventory row. It intentionally has no raw
 * payload object: the drawer can only render the small, already-displayed
 * whitelist assembled at the table boundary. */
type StaticInventoryDetail = {
  title: string;
  fields: Array<{ label: string; value: string; mono?: boolean }>;
};

function ClearPassView({
  data,
  navigate,
  density,
  lab,
  tab,
  setTab,
  q,
  setQ,
  status,
  setStatus,
  category,
  setCategory,
  enabled,
  setEnabled,
  endpointPage,
  clearpassHealth,
  clearpassNote,
  loadEndpointPage,
  refreshEndpointPage,
  reload,
  mergeDemo,
  mergeDemoEndpointPage,
}: {
  data: ClearPassData;
  navigate: ReturnType<typeof useNavigate>;
  density: 'comfortable' | 'compact';
  lab: boolean;
  tab: ClearPassTab;
  setTab: (v: ClearPassTab) => void;
  q: string;
  setQ: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  enabled: string;
  setEnabled: (v: string) => void;
  endpointPage: ClearPassEndpointPage | null;
  clearpassHealth: 'healthy' | 'degraded' | 'warning' | 'unlinked' | null;
  clearpassNote: string | null;
  loadEndpointPage: (offset: number) => Promise<void>;
  refreshEndpointPage: () => Promise<void>;
  /** Live mode: re-fetch the whole envelope after a landed write. */
  reload: () => Promise<void>;
  /** Demo mode: apply the reviewed write to the fixture world on screen. */
  mergeDemo: (fn: (d: ClearPassData) => ClearPassData) => void;
  mergeDemoEndpointPage: (fn: (page: ClearPassEndpointPage) => ClearPassEndpointPage) => void;
}) {
  const { toast } = useToast();
  const { tableColumns, setTableColumns } = useSettings();
  const [writeDrawer, setWriteDrawer] = useState<WriteDrawerState>(null);
  const [inventoryView, setInventoryView] = useState<StaticInventoryDetail | null>(null);
  /** The service whose detail drawer is open (null = none). */
  const [serviceView, setServiceView] = useState<ClearPassServiceRow | null>(null);
  /* Keyboard multi-select on the endpoints table raises Export selected /
   * Copy MACs / Copy selection link. Cleared when leaving the Endpoints tab so
   * a stale bar cannot act on rows that are no longer on screen. */
  const [selectedEndpointKeys, setSelectedEndpointKeys] = useState<string[]>([]);
  /* Services multi-select raises Export selected / Copy names / Copy selection link (Loop 174/181). */
  const [selectedServiceKeys, setSelectedServiceKeys] = useState<string[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  /* Deep link: /clearpass?macs=aa\nbb (bulk Copy selection link). Read off the URL
   * like Clients ?macs= — must not drift from the address bar. */
  const macsFilter = namesFilterForParam(searchParams.get('macs'));
  const macsFilterLc =
    macsFilter === null
      ? null
      : macsFilter.map((mac) => mac.trim().toLowerCase()).filter(Boolean);
  /* Deep link: /clearpass?tab=services&services=id1\nid2 (bulk Copy selection link). */
  const servicesFilter = namesFilterForParam(searchParams.get('services'));
  const [prevEndpointTab, setPrevEndpointTab] = useState(tab);
  if (prevEndpointTab !== tab) {
    setPrevEndpointTab(tab);
    if (tab !== 'endpoints' && selectedEndpointKeys.length > 0) {
      setSelectedEndpointKeys([]);
    }
    if (tab !== 'services' && selectedServiceKeys.length > 0) {
      setSelectedServiceKeys([]);
    }
  }
  const demo = data.dataSource === 'demo';
  /* Pure live or clearpass blend (demo chrome + live CPPM sections). */
  const sectionLive =
    data.dataSource === 'live' || (data.blended?.includes('clearpass') ?? false);
  const canWrite = demo || data.canWrite === true;
  const filteredServices = useMemo(() => {
    const base = filterServicesForView(data.services, q, enabled);
    if (base === undefined || servicesFilter === null) return base;
    const ids = new Set(servicesFilter);
    return base.filter((s) => ids.has(s.id));
  }, [data.services, q, enabled, servicesFilter]);
  const servicesPresent =
    servicesFilter === null || data.services === undefined
      ? 0
      : servicesFilter.filter((id) => data.services!.some((s) => s.id === id)).length;
  /* Enabled chips count over q only (not enabled) so operators still see the
   * full enabled/disabled mix while a chip is active — Loop 149. */
  const enabledUniverse = useMemo(
    () => filterServicesForView(data.services, q, 'all') ?? [],
    [data.services, q],
  );
  const ENABLED_CHIP_META: Array<{ key: '1' | '0'; label: string; tone: 'success' | 'neutral' }> = [
    { key: '1', label: 'Enabled', tone: 'success' },
    { key: '0', label: 'Disabled', tone: 'neutral' },
  ];
  const enabledChips = ENABLED_CHIP_META.map((m) => ({
    ...m,
    count: enabledUniverse.filter((s) =>
      m.key === '1' ? s.enabled === true : s.enabled === false,
    ).length,
  })).filter((c) => c.count > 0 || enabled === c.key);
  const endpointColumns: Array<DataTableColumn<EndpointRow>> = [
    {
      key: 'status',
      title: 'Status',
      hideable: false,
      render: (row) => (
        <Badge tone={statusTone(row.status)} dot>
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'mac',
      title: 'MAC',
      hideable: false,
      render: (row) => (
        <button
          type="button"
          onClick={() => navigate(`/auth-events?q=${encodeURIComponent(row.mac)}`)}
          className="nt-mono-link nt-ta-left"
        >
          {row.mac}
        </button>
      ),
    },
    {
      key: 'hostname',
      title: 'Hostname',
      render: (row) => (
        <>
          {row.hostname ?? '—'}
          {row.description ? <div className="nt-hint-muted">{row.description}</div> : null}
        </>
      ),
    },
    {
      key: 'ip',
      title: 'IP',
      render: (row) => <span className="nt-hint-muted">{row.ip ?? '—'}</span>,
    },
    {
      key: 'category',
      title: 'Category',
      render: (row) => (
        <>
          {row.category ?? '—'}
          {row.insightTags && row.insightTags.length > 0 ? (
            <div className="nt-chip-wrap nt-pad-top-4">
              {row.insightTags.map((tag) => (
                <Badge key={tag} tone="neutral">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
        </>
      ),
    },
    {
      key: 'os',
      title: 'OS / Family',
      render: (row) => [row.family, row.os].filter(Boolean).join(' · ') || '—',
    },
    {
      key: 'profile',
      title: 'Profile',
      render: (row) => row.profile ?? '—',
    },
    {
      key: 'updated',
      title: 'Updated',
      render: (row) => <span className="nt-hint-muted">{row.updatedAt ?? '—'}</span>,
    },
    {
      key: 'edit',
      title: '',
      hideable: false,
      render: (row) =>
        canWrite ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWriteDrawer({ kind: 'editEndpoint', row })}
            aria-label={`Edit endpoint ${row.mac}`}
          >
            Edit
          </Button>
        ) : null,
    },
  ];

  const [previousCanWrite, setPreviousCanWrite] = useState(canWrite);
  if (previousCanWrite !== canWrite) {
    setPreviousCanWrite(canWrite);
    if (!canWrite && writeDrawer !== null) setWriteDrawer(null);
  }
  /** The table only ever sees this one on-demand page, never the screen cache. */
  const endpoints = useMemo(() => endpointPage?.endpoints ?? [], [endpointPage?.endpoints]);
  const loadedEndpointCount = endpoints.length;
  const authEvents = data.authEvents;
  const missingSources = data.missingSources ?? [];

  const stats = useMemo<StatDef[]>(() => {
    const known = endpoints.filter((e) => e.status === 'Known').length;
    const unknown = endpoints.filter((e) => e.status === 'Unknown').length;
    const disabled = endpoints.filter((e) => e.status === 'Disabled').length;
    const total = endpointPage?.total ?? data.endpointTotal ?? null;
    return [
      { label: 'Total endpoints', value: total === null ? '—' : String(total), delta: total === null ? 'not reported by ClearPass' : 'reported by ClearPass', tone: 'neutral' },
      { label: 'Known (page)', value: String(known), delta: 'loaded endpoint page only', tone: 'positive' },
      { label: 'Unknown (page)', value: String(unknown), delta: unknown > 0 ? 'needs profiling on this page' : 'none on this page', tone: unknown > 0 ? 'negative' : 'neutral' },
      { label: 'Disabled (page)', value: String(disabled), delta: 'access revoked on this page', tone: 'neutral' },
      // A live count comes out of the poller's ≤200-event page — minutes of
      // traffic, not a day. Only the fixture feed is a 24h cut (the same rule
      // AuthEvents words its live fail-reason bars by).
      { label: 'Auth events', value: String(authEvents.length), delta: sectionLive ? 'current poller snapshot' : 'last 24h', tone: 'neutral' },
    ];
  }, [endpoints, endpointPage?.total, data.endpointTotal, authEvents, sectionLive]);

  /* Server already applied q/status/category on the page route; keep a cheap
     client pass so a stale page cannot flash unfiltered rows mid-request.
     Status chips count over q+category+macs (not status); category chips over
     q+status+macs (not category) so each row still shows the full mix while its
     own chip is on. Selection deep-link `macs=` narrows every universe. */
  const ql = q.trim().toLowerCase();
  const matchesQ = (e: (typeof endpoints)[number]) =>
    !ql ||
    (e.hostname ?? '').toLowerCase().includes(ql) ||
    e.mac.toLowerCase().includes(ql) ||
    (e.ip ?? '').toLowerCase().includes(ql);
  const matchesStatus = (e: (typeof endpoints)[number]) => status === 'all' || e.status === status;
  const matchesCategory = (e: (typeof endpoints)[number]) =>
    category === 'all' || e.category === category;
  const matchesMacs = (e: (typeof endpoints)[number]) =>
    macsFilterLc === null || macsFilterLc.includes((e.mac ?? '').trim().toLowerCase());
  const statusUniverse = endpoints.filter(
    (e) => matchesCategory(e) && matchesQ(e) && matchesMacs(e),
  );
  const categoryUniverse = endpoints.filter(
    (e) => matchesStatus(e) && matchesQ(e) && matchesMacs(e),
  );
  const rows = endpoints.filter(
    (e) => matchesStatus(e) && matchesCategory(e) && matchesQ(e) && matchesMacs(e),
  );
  const macsPresent =
    macsFilter === null
      ? 0
      : macsFilter.filter((mac) =>
          endpoints.some((e) => (e.mac ?? '').trim().toLowerCase() === mac.trim().toLowerCase()),
        ).length;
  const statusChipKeys = uniq([
    ...statusUniverse.map((e) => e.status),
    ...(status !== 'all' ? [status] : []),
  ]).sort((a, b) => a.localeCompare(b));
  const statusChips = statusChipKeys.map((key) => ({
    key,
    label: key,
    tone: statusTone(key),
    count: statusUniverse.filter((e) => e.status === key).length,
  }));
  const categoryChipKeys = uniq([
    ...categoryUniverse.map((e) => e.category),
    ...(category !== 'all' ? [category] : []),
  ])
    .filter((v): v is string => Boolean(v))
    .sort((a, b) => a.localeCompare(b));
  const categoryChips = categoryChipKeys
    .map((key) => ({
      key,
      label: key,
      count: categoryUniverse.filter((e) => e.category === key).length,
    }))
    .filter((c) => c.count > 0 || category === c.key);

  /* Prefer option values from the loaded page; keep the active selection even
     when the filtered page no longer contains that status/category. */
  const statusOptions = [{ value: 'all', label: 'All statuses' }].concat(
    uniq([
      ...endpoints.map((e) => e.status),
      ...(status !== 'all' ? [status] : []),
    ]).map((v) => ({ value: v, label: v })),
  );
  const categoryOptions = [{ value: 'all', label: 'All categories' }].concat(
    uniq([
      ...endpoints.map((e) => e.category),
      ...(category !== 'all' ? [category] : []),
    ])
      .filter((v): v is string => Boolean(v))
      .map((v) => ({ value: v, label: v })),
  );

  const recentAuth = authEvents.slice(0, 20);
  const recentAuthColumns: Array<DataTableColumn<(typeof recentAuth)[number]>> = [
    {
      key: 'time',
      title: 'Time',
      hideable: false,
      render: (ev) => <span className="nt-hint-muted">{ev.at ? hhmmssLocal(ev.at) : ev.time}</span>,
    },
    {
      key: 'result',
      title: 'Result',
      hideable: false,
      render: (ev) => (
        <Badge tone={ev.tone} dot>
          {ev.result}
        </Badge>
      ),
    },
    { key: 'who', title: 'Username', render: (ev) => ev.who },
    {
      key: 'mac',
      title: 'MAC',
      render: (ev) => <span className="nt-mono-11">{ev.mac}</span>,
    },
    {
      key: 'method',
      title: 'Method',
      render: (ev) => <span className="nt-body-sec">{ev.method}</span>,
    },
  ];


  return (
    <div className="nt-stack nt-recon-reveal nt-clearpass-shell nt-section-panel nt-plane-shell">
      <ScreenHeader
        overline="Operate / ClearPass"
        title="ClearPass"
        subtitle="Endpoint policy, profiling, and authentication from HPE ClearPass."
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · access
            </span>
            <Badge plane>ClearPass</Badge>
            {/* LIVE on pure live and clearpass blend alike — stamp alone is easy to miss. */}
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  /* Prefer the live address bar (tab/filter write-back); fall back
                     to state when the host has not mirrored router search. */
                  const qs =
                    window.location.search ||
                    (() => {
                      const next = new URLSearchParams();
                      if (tab !== 'endpoints') next.set('tab', tab);
                      if (q.trim()) next.set('q', q.trim());
                      if (status !== 'all') next.set('status', status);
                      if (category !== 'all') next.set('category', category);
                      if (enabled !== 'all') next.set('enabled', enabled);
                      const s = next.toString();
                      return s ? `?${s}` : '';
                    })();
                  const url = `${window.location.origin}${window.location.pathname}${qs}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Filter link copied', {
                      description: qs.replace(/^\?/, '') || 'default ClearPass view',
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
            {tab === 'services' && filteredServices && filteredServices.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const n = exportTableCsv(
                    'clearpass-services.csv',
                    [
                      'id',
                      'name',
                      'type',
                      'description',
                      'template',
                      'enabled',
                      'hitCount',
                      'orderNo',
                      'authSources',
                      'rulesSummary',
                    ],
                    filteredServices.map((s) => [
                      s.id ?? '',
                      s.name ?? '',
                      s.type ?? '',
                      s.description ?? '',
                      s.template ?? '',
                      s.enabled === true ? 'yes' : s.enabled === false ? 'no' : '',
                      s.hitCount == null ? '' : String(s.hitCount),
                      s.orderNo == null ? '' : String(s.orderNo),
                      (s.authSources ?? []).join('; '),
                      s.rulesSummary ?? '',
                    ]),
                  );
                  toast(`Exported ${n} service${n === 1 ? '' : 's'}`, {
                    description: 'clearpass-services.csv — filtered services on this tab.',
                  });
                }}
              >
                Export CSV
              </Button>
            ) : null}
            {tab === 'endpoints' && rows.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const n = exportTableCsv(
                    'clearpass-endpoints.csv',
                    ['hostname', 'mac', 'ip', 'status', 'category', 'family', 'os'],
                    rows.map((e) => [
                      e.hostname ?? '',
                      e.mac ?? '',
                      e.ip ?? '',
                      e.status ?? '',
                      e.category ?? '',
                      e.family ?? '',
                      e.os ?? '',
                    ]),
                  );
                  toast(`Exported ${n} endpoint${n === 1 ? '' : 's'}`, {
                    description: 'clearpass-endpoints.csv — filtered rows on this loaded page.',
                  });
                }}
              >
                Export CSV
              </Button>
            ) : null}
            {sectionLive ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const qs = new URLSearchParams();
                    if (q.trim()) qs.set('q', q.trim());
                    /* Endpoints tab follows the on-screen status/category slice;
                       Auth tab prefers sessions; Services uses dedicated columns;
                       other tabs keep the full endpoints+sessions export. */
                    if (tab === 'endpoints') {
                      if (status !== 'all') qs.set('status', status);
                      if (category !== 'all') qs.set('category', category);
                      qs.set('part', 'endpoints');
                    } else if (tab === 'auth') {
                      qs.set('part', 'sessions');
                    } else if (tab === 'services') {
                      if (enabled !== 'all') qs.set('enabled', enabled);
                      qs.set('part', 'services');
                    }
                    const suffix = qs.toString() ? `?${qs}` : '';
                    const filename =
                      tab === 'services' ? 'clearpass-services.csv' : 'clearpass-export.csv';
                    const res = await downloadApiCsv(`/api/clearpass/export${suffix}`, filename);
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description:
                          tab === 'endpoints'
                            ? 'clearpass-export.csv — filtered endpoints.'
                            : tab === 'auth'
                              ? 'clearpass-export.csv — auth sessions.'
                              : tab === 'services'
                                ? 'clearpass-services.csv — filtered services.'
                                : 'clearpass-export.csv — endpoints + auth sessions.',
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
            <Button variant="ghost" size="sm" onClick={() => navigate('/auth-events')}>
              Auth events →
            </Button>
          </>
}
      />

      <div className="nt-plane-theater" role="note">NightDesk · ClearPass ECG · policy · endpoints · identity</div>

      <StatRow stats={stats} />

      <VisualReferencePanel target={{ kind: 'connector', id: 'clearpass', plane: 'CLEARPASS' }} />
      <ConfigRecommendationsPanel title="ClearPass-related recommendations" limit={8} />

      {sectionLive && clearpassHealth && clearpassHealth !== 'healthy' ? (
        <Alert
          tone={clearpassHealth === 'unlinked' ? 'info' : 'warning'}
          title={
            clearpassHealth === 'unlinked'
              ? 'ClearPass is not linked'
              : `ClearPass connector is ${clearpassHealth}`
          }
        >
          <span className="nt-body-sm">
            {clearpassNote
              ? clearpassNote
              : clearpassHealth === 'unlinked'
                ? 'Link ClearPass under Connected systems to pull the endpoint repository and auth feed.'
                : 'Empty tables below are not proof that CPPM has no endpoints — the connector could not complete a healthy pull. Repair credentials or TLS on Connected systems, then retest.'}
            {clearpassNote && /tls|certificate|cert|self-signed|untrusted/i.test(clearpassNote) ? (
              <>
                {' '}
                If the host uses a private CA, either install the CA on this portal host or enable
                verifyTls only after the chain is trusted — never leave TLS verification off in
                production.
              </>
            ) : null}
          </span>
          <div className="nt-filter-bar nt-mt-10 nt-gap-8 nt-row">
            <Button variant="secondary" size="sm" onClick={() => navigate('/systems?plane=clearpass')}>
              Repair ClearPass on Connected systems
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate('/systems')}>
              All systems
            </Button>
          </div>
        </Alert>
      ) : null}

      {missingSources.length > 0 ? (
        <Alert
          tone="warning"
          title={`${missingSources.length} linked plane${
            missingSources.length === 1 ? '' : 's'
          } contributed no ClearPass data: ${missingSources.join(', ')}`}
        >
          <span className="nt-body-sm">
            The endpoint repository or auth feed has not come back from this plane — treat the counts above as
            a lower bound, not the whole estate.
          </span>
        </Alert>
      ) : null}

      <SegmentedControl options={TAB_OPTIONS} value={tab} onValueChange={(v) => setTab(v as ClearPassTab)} ariaLabel="ClearPass sections" />

      {!canWrite ? (
        <Alert tone="info" title="ClearPass writes are unavailable">
          This linked ClearPass connector has a read-only connector grant. Inventory remains available, but endpoint
          and local-user mutation controls are hidden.
        </Alert>
      ) : null}

      {tab === 'endpoints' ? (
        <>
          <SectionHeader
            label="Endpoint repository"
            meta={
              endpointPage
                ? rows.length === loadedEndpointCount
                  ? `${loadedEndpointCount} loaded endpoint ${loadedEndpointCount === 1 ? 'row' : 'rows'}`
                  : `${rows.length} of ${loadedEndpointCount} loaded endpoint rows`
                : 'LOADING PAGE'
            }
          />

          <div className="nt-filter-bar nt-sticky-filters">
            <div className="nt-filter-field nt-w-250">
              <Input
                size="sm"
                mono
                placeholder="hostname, MAC, IP…"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                }}
                aria-label="Filter endpoints"
              />
            </div>
            <div className="nt-filter-field nt-w-160">
              <Select
                options={statusOptions}
                value={status}
                onValueChange={(value) => {
                  setStatus(value);
                }}
                size="sm"
                aria-label="Endpoint status"
              />
            </div>
            <div className="nt-filter-field nt-w-180">
              <Select
                options={categoryOptions}
                value={category}
                onValueChange={(value) => {
                  setCategory(value);
                }}
                size="sm"
                aria-label="Endpoint category"
              />
            </div>
            {canWrite ? <div className="nt-ml-auto">
              <Button variant="secondary" size="sm" onClick={() => setWriteDrawer({ kind: 'register' })}>
                Register endpoint
              </Button>
            </div> : null}
          </div>

          {statusChips.length > 0 ? (
            <div className="nt-chip-row" role="group" aria-label="Endpoint status">
              <span className="nt-chip-row__label">Status</span>
              {statusChips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setStatus(status === c.key ? 'all' : c.key)}
                  className={status === c.key ? 'nt-chip nt-chip--active' : 'nt-chip'}
                  aria-pressed={status === c.key}
                >
                  <Badge tone={c.tone}>{c.label}</Badge>
                  <span className="nt-chip__count">{c.count}</span>
                </button>
              ))}
            </div>
          ) : null}

          {categoryChips.length > 0 ? (
            <div className="nt-chip-row" role="group" aria-label="Endpoint category">
              <span className="nt-chip-row__label">Category</span>
              {categoryChips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setCategory(category === c.key ? 'all' : c.key)}
                  className={
                    category === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
                  }
                  aria-pressed={category === c.key}
                  data-category={c.key}
                >
                  <Badge tone="neutral">{c.label}</Badge>
                  <span className="nt-chip__count">{c.count}</span>
                </button>
              ))}
            </div>
          ) : null}

          <span className="nt-body-sm nt-hint-muted">
            {endpointPage?.dataSource === 'live'
              ? 'Live filters narrow the vendor page just returned; Next still walks the ClearPass repository.'
              : q.trim() || status !== 'all' || category !== 'all'
                ? `Filtered repository page — ${endpointPage?.total ?? loadedEndpointCount} matching ${
                    (endpointPage?.total ?? loadedEndpointCount) === 1 ? 'endpoint' : 'endpoints'
                  }.`
                : `Showing ${loadedEndpointCount} ${loadedEndpointCount === 1 ? 'endpoint' : 'endpoints'} on this page.`}
          </span>

          {endpointPage === null ? (
            <div className="nt-center-pad" role="status" aria-label="Loading endpoints">
              <div className="nt-stack nt-gap-6">
                <Skeleton height={12} width="32%" />
                <Skeleton height={32} />
                <Skeleton height={32} />
                <Skeleton height={32} />
              </div>
            </div>
          ) : endpointPage.state === 'unavailable' ? (
            <EmptyState
              title="Endpoint page unavailable"
              description="ClearPass cannot provide an on-demand endpoint page right now."
            />
          ) : endpointPage.state === 'failed' ? (
            <EmptyState
              title="Endpoint page could not be loaded"
              description="ClearPass did not return a readable endpoint page."
            >
              <Button variant="secondary" size="sm" onClick={() => void loadEndpointPage(endpointPage.offset)}>
                Retry page
              </Button>
            </EmptyState>
          ) : endpointPage.state === 'empty' ? (
            <EmptyState
              title="ClearPass returned an empty endpoint page"
              description={
                endpointPage.total === null
                  ? 'The requested page contains no endpoint rows; ClearPass did not report a repository-wide total.'
                  : `ClearPass reports ${endpointPage.total} total endpoints; this requested page contains no rows.`
              }
            />
          ) : rows.length === 0 ? (
            endpoints.length === 0 ? (
              <EmptyState
                title="No readable endpoints on this page"
                description="ClearPass returned endpoint records, but none contained the fields needed for a safe table row."
              />
            ) : (
              <EmptyState
                title={
                  macsFilter !== null
                    ? 'No endpoints match this selection'
                    : 'Nothing matches that filter'
                }
                description={
                  macsFilter !== null
                    ? 'Clear the selection filter to restore the endpoints list under the current search / status / category filters.'
                    : 'Loosen the search, status or category filter — Next page still walks the repository when more rows exist.'
                }
              >
                {macsFilter !== null ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const next = new URLSearchParams(searchParams);
                      next.delete('macs');
                      setSearchParams(next, { replace: true });
                      setSelectedEndpointKeys([]);
                    }}
                  >
                    Clear selection filter
                  </Button>
                ) : q.trim() || status !== 'all' || category !== 'all' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setQ('');
                      setStatus('all');
                      setCategory('all');
                      setSelectedEndpointKeys([]);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </EmptyState>
            )
          ) : (
            <div className="nt-stack nt-gap-8">
              <div className="nt-row-between">
                <span className="nd-micro-label nt-micro-label">Endpoints</span>
                <div className="nt-row nt-gap-8">
                  <TableViewOptions
                    columns={endpointColumns}
                    config={tableColumns.clearpassEndpoints ?? {}}
                    onChange={(config) => setTableColumns('clearpassEndpoints', config)}
                  />
                  <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
                </div>
              </div>
              {macsFilter !== null ? (
                <div className="nt-chip-row" role="group" aria-label="Selection deep link">
                  <button
                    type="button"
                    onClick={() => {
                      const next = new URLSearchParams(searchParams);
                      next.delete('macs');
                      setSearchParams(next, { replace: true });
                    }}
                    title={macsFilter.join(', ')}
                    className="nt-chip nt-chip--active"
                  >
                    {macsPresent === macsFilter.length
                      ? `${macsFilter.length} selected MAC${macsFilter.length === 1 ? '' : 's'}`
                      : `${macsPresent} of ${macsFilter.length} selected MACs present`}
                    {' — clear'}
                  </button>
                </div>
              ) : null}
              <DataTable
                ariaLabel="ClearPass endpoints"
                density={density}
                columns={endpointColumns}
                rows={rows}
                rowKey={(e) => e.id}
                columnsConfig={tableColumns.clearpassEndpoints}
                onColumnsConfigChange={(config) => setTableColumns('clearpassEndpoints', config)}
                selectedKeys={selectedEndpointKeys}
                onSelectionChange={setSelectedEndpointKeys}
                rowTone={(e) => statusTone(e.status)}
              />
              {selectedEndpointKeys.length > 0 ? (
                <div
                  className="nt-configure-bulk-bar nt-bulk-glass"
                  role="region"
                  aria-label="Endpoint selection actions"
                >
                  <span className="nt-configure-bulk-bar__count">{`${selectedEndpointKeys.length} SELECTED`}</span>
                  <span className="nt-configure-bulk-bar__hint">
                    export, copy MACs, copy names, or share a selection link for only the endpoints you marked — full list export stays in the header
                  </span>
                  <span className="nt-configure-bulk-bar__actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const selected = new Set(selectedEndpointKeys);
                        const picked = rows.filter((e) => selected.has(e.id));
                        if (picked.length === 0) {
                          toast('No selected endpoints still in view', {
                            description: 'Clear selection or adjust filters.',
                            tone: 'info',
                          });
                          return;
                        }
                        const n = exportTableCsv(
                          'clearpass-endpoints-selected.csv',
                          [
                            'mac',
                            'hostname',
                            'ip',
                            'status',
                            'category',
                            'family',
                            'os',
                            'profile',
                            'updatedAt',
                            'description',
                          ],
                          picked.map((e) => [
                            e.mac,
                            e.hostname ?? '',
                            e.ip ?? '',
                            e.status,
                            e.category ?? '',
                            e.family ?? '',
                            e.os ?? '',
                            e.profile ?? '',
                            e.updatedAt ?? '',
                            e.description ?? '',
                          ]),
                        );
                        toast(`Exported ${countOf(n, 'selected endpoint')}`, {
                          description: 'clearpass-endpoints-selected.csv — profile fields only.',
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
                          const selected = new Set(selectedEndpointKeys);
                          const picked = rows.filter((e) => selected.has(e.id));
                          if (picked.length === 0) {
                            toast('No selected endpoints still in view', {
                              description: 'Clear selection or adjust filters.',
                              tone: 'info',
                            });
                            return;
                          }
                          const macs = [
                            ...new Set(
                              picked
                                .map((e) => (e.mac ?? '').trim())
                                .filter(Boolean),
                            ),
                          ];
                          if (macs.length === 0) {
                            toast('No MACs on the selected endpoints', {
                              description: 'Those rows did not publish a MAC — use Copy names or export CSV instead.',
                              tone: 'info',
                            });
                            return;
                          }
                          const text = macs.join('\n');
                          try {
                            await navigator.clipboard.writeText(text);
                            toast(`Copied ${countOf(macs.length, 'MAC')}`, {
                              description:
                                macs.length < picked.length
                                  ? `${picked.length - macs.length} selected without a MAC skipped`
                                  : 'newline-joined · paste into NAC or a ticket',
                              tone: 'success',
                            });
                          } catch {
                            toast('Could not copy MACs', { description: text, tone: 'warning' });
                          }
                        })();
                      }}
                    >
                      Copy MACs
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void (async () => {
                          const selected = new Set(selectedEndpointKeys);
                          const picked = rows.filter((e) => selected.has(e.id));
                          if (picked.length === 0) {
                            toast('No selected endpoints still in view', {
                              description: 'Clear selection or adjust filters.',
                              tone: 'info',
                            });
                            return;
                          }
                          const names = [
                            ...new Set(
                              picked
                                .map((e) => (e.hostname ?? '').trim())
                                .filter((name) => name && name !== '—'),
                            ),
                          ];
                          if (names.length === 0) {
                            toast('No names on the selected endpoints', {
                              description: 'Those rows did not publish a hostname — export CSV instead.',
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
                                  ? `${picked.length - names.length} selected without a hostname skipped`
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
                          const selected = new Set(selectedEndpointKeys);
                          const picked = rows.filter((e) => selected.has(e.id));
                          if (picked.length === 0) {
                            toast('No selected endpoints still in view', {
                              description: 'Clear selection or adjust filters.',
                              tone: 'info',
                            });
                            return;
                          }
                          const macs = [
                            ...new Set(
                              picked
                                .map((e) => (e.mac ?? '').trim())
                                .filter(Boolean),
                            ),
                          ];
                          if (macs.length === 0) {
                            toast('No MACs on the selected endpoints', {
                              description: 'Those rows did not publish a MAC — use Copy names or export CSV instead.',
                              tone: 'info',
                            });
                            return;
                          }
                          const next = new URLSearchParams(searchParams);
                          next.set('macs', macs.join('\n'));
                          const qs = next.toString();
                          const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                          try {
                            await navigator.clipboard.writeText(url);
                            toast('Selection link copied', {
                              description: `${macs.length} MAC${macs.length === 1 ? '' : 's'} · macs=`,
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
                    <Button variant="ghost" size="sm" onClick={() => setSelectedEndpointKeys([])}>
                      Clear
                    </Button>
                  </span>
                </div>
              ) : null}
            </div>
          )}

          {endpointPage !== null && endpointPage.state === 'ok' ? (
            <div className="nt-row nt-gap-8">
              <Button
                variant="secondary"
                size="sm"
                disabled={endpointPage.offset === 0}
                onClick={() => void loadEndpointPage(Math.max(0, endpointPage.offset - endpointPage.limit))}
                aria-label="Previous endpoint page"
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={endpointPage.nextOffset === null}
                onClick={() => endpointPage.nextOffset !== null && void loadEndpointPage(endpointPage.nextOffset)}
                aria-label="Next endpoint page"
              >
                Next
              </Button>
              {endpointPage.more === 'unknown' ? (
                <span className="nt-body-sm nt-hint-muted">
                  ClearPass did not provide a total, so another page cannot be requested safely.
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {tab === 'auth' ? (
        <>
          <SectionHeader label="Recent auth events" meta="LAST 20" />
          {recentAuth.length === 0 ? (
            <EmptyState
              title="No auth events in this window"
              description="ClearPass has not recorded a RADIUS decision recently."
            />
          ) : (
            <DataTable
              ariaLabel="Recent ClearPass auth events"
              density={density}
              columns={recentAuthColumns}
              rows={recentAuth}
              rowKey={(ev, i) => `${ev.time}|${ev.mac}|${i}`}
              rowTone={(ev) => ev.tone}
            />
          )}
          <div>
            <Button variant="ghost" size="sm" onClick={() => navigate('/auth-events')}>
              View full auth events →
            </Button>
          </div>
        </>
      ) : null}

      {tab === 'network' ? <NetworkDevicesSection rows={data.networkDevices} density={density} onView={setInventoryView} /> : null}
      {tab === 'sources' ? <AuthSourcesSection rows={data.authSources} density={density} onView={setInventoryView} /> : null}
      {tab === 'roles' ? <RolesSection rows={data.roles} density={density} onView={setInventoryView} /> : null}
      {tab === 'enforcement' ? (
        <EnforcementSection
          policies={data.enforcementPolicies}
          profiles={data.enforcementProfiles}
          density={density}
          onView={setInventoryView}
        />
      ) : null}
      {tab === 'users' ? (
        <LocalUsersSection
          rows={data.localUsers}
          density={density}
          onAdd={canWrite ? () => setWriteDrawer({ kind: 'createUser' }) : undefined}
          onEdit={canWrite ? (row) => setWriteDrawer({ kind: 'editUser', row }) : undefined}
        />
      ) : null}
      {tab === 'services' ? (
        <>
          <div className="nt-filter-bar nt-sticky-filters">
            <div className="nt-filter-field nt-w-250">
              <Input
                size="sm"
                mono
                placeholder="name, type, template, rules…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Filter services"
              />
            </div>
            <div className="nt-filter-field nt-w-160">
              <Select
                options={[
                  { value: 'all', label: 'All statuses' },
                  { value: '1', label: 'Enabled' },
                  { value: '0', label: 'Disabled' },
                ]}
                value={enabled}
                onValueChange={setEnabled}
                size="sm"
                aria-label="Service enabled"
              />
            </div>
          </div>
          {enabledChips.length > 0 ? (
            <div className="nt-chip-row" role="group" aria-label="Service enabled state">
              <span className="nt-chip-row__label">Enabled</span>
              {enabledChips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setEnabled(enabled === c.key ? 'all' : c.key)}
                  className={
                    enabled === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
                  }
                  aria-pressed={enabled === c.key}
                  data-enabled={c.key}
                >
                  <Badge tone={c.tone}>{c.label}</Badge>
                  <span className="nt-chip__count">{c.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          {servicesFilter !== null ? (
            <div className="nt-chip-row" role="group" aria-label="Selection deep link">
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('services');
                  setSearchParams(next, { replace: true });
                  setSelectedServiceKeys([]);
                }}
                title={servicesFilter.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {servicesPresent === servicesFilter.length
                  ? `${servicesFilter.length} selected service${servicesFilter.length === 1 ? '' : 's'}`
                  : `${servicesPresent} of ${servicesFilter.length} selected services present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          <ServicesSection
            services={filteredServices}
            servicesTotal={data.services?.length}
            deviceGroups={data.deviceGroups}
            density={density}
            selectedServiceKeys={selectedServiceKeys}
            onServiceSelectionChange={setSelectedServiceKeys}
            onView={setServiceView}
            onViewDeviceGroup={setInventoryView}
            selectionFilterActive={servicesFilter !== null}
            onClearFilters={() => {
              setQ('');
              setEnabled('all');
              setSelectedServiceKeys([]);
              /* Drop URL-owned triage params in the same turn so the
                 address-bar re-seed cannot restore a stale q/enabled. */
              const next = new URLSearchParams(searchParams);
              next.delete('q');
              next.delete('enabled');
              if (next.toString() !== searchParams.toString()) {
                setSearchParams(next, { replace: true });
              }
            }}
          />
        </>
      ) : null}

      {inventoryView ? (
        <StaticInventoryDetailDrawer
          row={inventoryView}
          onOpenChange={(open) => {
            if (!open) setInventoryView(null);
          }}
        />
      ) : null}

      {/* The service detail drawer — a READ, mounted only while open (keyed
          by the service id) so its fetch state starts fresh per opening,
          exactly like the write drawers below. */}
      {serviceView ? (
        <ServiceDetailDrawer
          key={serviceView.id}
          row={serviceView}
          onOpenChange={(v) => {
            if (!v) setServiceView(null);
          }}
        />
      ) : null}

      {/* The reviewed write drawers — endpoints and local users are the only
          two CPPM datasets the portal writes; policy stays in ClearPass. Each
          mounts only while open (keyed by the row it edits), so its form
          state starts fresh per opening — no reset effects. */}
      {canWrite && writeDrawer?.kind === 'register' ? (
        <RegisterEndpointDrawer
          onOpenChange={(v) => {
            if (!v) setWriteDrawer(null);
          }}
          demo={demo}
          lab={lab}
          onDemoApplied={(form) =>
            mergeDemoEndpointPage((page) => ({
              ...page,
              endpoints: [...page.endpoints, demoEndpointRowFor(form)].slice(0, page.limit),
              total: page.total === null ? null : page.total + 1,
            }))
          }
          reload={reload}
          reloadEndpointPage={refreshEndpointPage}
        />
      ) : null}
      {canWrite && writeDrawer?.kind === 'editEndpoint' ? (
        <EditEndpointDrawer
          key={writeDrawer.row.id}
          row={writeDrawer.row}
          onOpenChange={(v) => {
            if (!v) setWriteDrawer(null);
          }}
          demo={demo}
          lab={lab}
          onDemoApplied={(row, form) =>
            mergeDemoEndpointPage((page) => ({
              ...page,
              endpoints: page.endpoints.map((e) =>
                e.id === row.id
                  ? {
                      ...e,
                      ...(form.status !== undefined ? { status: form.status } : {}),
                      ...(form.description !== undefined ? { description: form.description || null } : {}),
                    }
                  : e,
              ),
            }))
          }
          reload={reload}
          reloadEndpointPage={refreshEndpointPage}
        />
      ) : null}
      {canWrite && writeDrawer?.kind === 'createUser' ? (
        <LocalUserWriteDrawer
          mode="create"
          onOpenChange={(v) => {
            if (!v) setWriteDrawer(null);
          }}
          roles={data.roles}
          demo={demo}
          lab={lab}
          onDemoCreated={(form) =>
            mergeDemo((d) => ({
              ...d,
              localUsers: [...(d.localUsers ?? []), demoLocalUserRowFor(form)],
            }))
          }
          reload={reload}
        />
      ) : null}
      {canWrite && writeDrawer?.kind === 'editUser' ? (
        <LocalUserWriteDrawer
          key={writeDrawer.row.id}
          mode="edit"
          row={writeDrawer.row}
          onOpenChange={(v) => {
            if (!v) setWriteDrawer(null);
          }}
          roles={data.roles}
          demo={demo}
          lab={lab}
          onDemoUpdated={(row, form) =>
            mergeDemo((d) => ({
              ...d,
              localUsers: (d.localUsers ?? []).map((u) =>
                u.id === row.id
                  ? {
                      ...u,
                      ...(form.username !== undefined ? { username: form.username || null } : {}),
                      ...(form.roleName !== undefined ? { roleName: form.roleName } : {}),
                      ...(form.enabled !== undefined ? { enabled: form.enabled } : {}),
                    }
                  : u,
              ),
            }))
          }
          reload={reload}
        />
      ) : null}
    </div>
  );
}

// -- Policy inventories --------------------------------------------------------
//
// One section per CPPM collection the adapter walks alongside the endpoint
// repository. Every section keeps the three states distinct: rows the plane
// reported, a real EMPTY answer (the CPPM has none), and a key the envelope
// did not carry at all (this CPPM did not report the collection — a failed
// read, or a build that does not expose it). The absent case must never
// render as the empty one.

/** Section meta: the count when the plane reported, an honest flag when not. */
function inventoryMeta(rows: readonly unknown[] | undefined): string {
  return rows === undefined ? 'NOT REPORTED' : `${rows.length}`;
}

/** Gates one inventory table on the reported / empty / not-reported states. */
function InventoryGate({
  rows,
  notReportedDescription,
  emptyTitle,
  children,
}: {
  rows: readonly unknown[] | undefined;
  notReportedDescription: string;
  emptyTitle: string;
  children: ReactNode;
}) {
  if (rows === undefined) {
    return <EmptyState title="Not reported by this CPPM" description={notReportedDescription} />;
  }
  if (rows.length === 0) return <EmptyState title={emptyTitle} />;
  return <>{children}</>;
}

/** A nullable boolean fact: null is "the box did not say", never a guess. */
function boolText(value: boolean | null): string {
  return value === null ? '—' : value ? 'Yes' : 'No';
}

function reported(value: string | null): string {
  return value ?? 'Not reported';
}

function StaticInventoryDetailDrawer({
  row,
  onOpenChange,
}: {
  row: StaticInventoryDetail;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      width="md"
      title={row.title}
      description="Read-only inventory detail. No ClearPass changes can be made here."
    >
      {row.fields.map((field) => (
        <ReviewRow key={field.label} label={field.label} value={field.value} mono={field.mono} />
      ))}
    </Drawer>
  );
}

function networkDeviceDetail(row: ClearPassNetworkDeviceRow): StaticInventoryDetail {
  return {
    title: row.name,
    fields: [
      { label: 'IP address', value: reported(row.ipAddress), mono: true },
      { label: 'Vendor', value: reported(row.vendorName) },
      { label: 'CoA capable', value: boolText(row.coaCapable) },
      { label: 'RadSec enabled', value: boolText(row.radsecEnabled) },
      { label: 'Description', value: reported(row.description) },
    ],
  };
}

function authSourceDetail(row: ClearPassAuthSourceRow): StaticInventoryDetail {
  return {
    title: row.name,
    fields: [
      { label: 'Type', value: reported(row.type) },
      { label: 'Description', value: reported(row.description) },
    ],
  };
}

function roleDetail(row: ClearPassRoleRow): StaticInventoryDetail {
  return { title: row.name, fields: [{ label: 'Description', value: reported(row.description) }] };
}

function enforcementPolicyDetail(row: ClearPassEnforcementPolicyRow): StaticInventoryDetail {
  return {
    title: row.name,
    fields: [
      { label: 'Type', value: reported(row.enforcementType) },
      { label: 'Default profile', value: reported(row.defaultProfile) },
    ],
  };
}

function enforcementProfileDetail(row: ClearPassEnforcementProfileRow): StaticInventoryDetail {
  return {
    title: row.name,
    fields: [
      { label: 'Type', value: reported(row.type) },
      { label: 'Description', value: reported(row.description) },
    ],
  };
}

function deviceGroupDetail(row: ClearPassDeviceGroupRow): StaticInventoryDetail {
  return { title: row.name, fields: [{ label: 'Description', value: reported(row.description) }] };
}

function NetworkDevicesSection({
  rows,
  density,
  onView,
}: {
  rows: ClearPassNetworkDeviceRow[] | undefined;
  density: 'comfortable' | 'compact';
  onView: (row: StaticInventoryDetail) => void;
}) {
  const columns: Array<DataTableColumn<ClearPassNetworkDeviceRow>> = [
    {
      key: 'name',
      title: 'Name',
      hideable: false,
      sortValue: (d) => d.name,
      render: (d) => (
        <button
          type="button"
          onClick={() => onView(networkDeviceDetail(d))}
          className="nt-inventory-detail-btn"
          aria-label={`View network device ${d.name}`}
        >
          {d.name}
        </button>
      ),
    },
    {
      key: 'ip',
      title: 'IP',
      sortValue: (d) => d.ipAddress ?? '',
      render: (d) => <span className="nt-hint-muted">{d.ipAddress ?? '—'}</span>,
    },
    {
      key: 'vendor',
      title: 'Vendor',
      sortValue: (d) => d.vendorName ?? '',
      render: (d) => d.vendorName ?? '—',
    },
    {
      key: 'coa',
      title: 'CoA',
      sortValue: (d) => boolText(d.coaCapable),
      render: (d) => boolText(d.coaCapable),
    },
    {
      key: 'radsec',
      title: 'RadSec',
      sortValue: (d) => boolText(d.radsecEnabled),
      render: (d) => boolText(d.radsecEnabled),
    },
    {
      key: 'description',
      title: 'Description',
      sortValue: (d) => d.description ?? '',
      render: (d) => d.description ?? '—',
    },
  ];

  return (
    <>
      <SectionHeader label="Network devices" meta={inventoryMeta(rows)} />
      <InventoryGate
        rows={rows}
        notReportedDescription="ClearPass did not return its network-device inventory this cycle — the NAD list is unknown, not empty."
        emptyTitle="ClearPass reports no network devices"
      >
        <DataTable
          ariaLabel="ClearPass network devices"
          density={density}
          columns={columns}
          rows={rows ?? []}
          rowKey={(d) => d.id}
          onRowActivate={(d) => onView(networkDeviceDetail(d))}
          rowTone={(d) =>
            d.radsecEnabled ? 'success' : d.coaCapable ? 'info' : 'neutral'
          }
        />
      </InventoryGate>
    </>
  );
}

function AuthSourcesSection({
  rows,
  density,
  onView,
}: {
  rows: ClearPassAuthSourceRow[] | undefined;
  density: 'comfortable' | 'compact';
  onView: (row: StaticInventoryDetail) => void;
}) {
  const columns: Array<DataTableColumn<ClearPassAuthSourceRow>> = [
    {
      key: 'name',
      title: 'Name',
      hideable: false,
      sortValue: (s) => s.name,
      render: (s) => (
        <button
          type="button"
          onClick={() => onView(authSourceDetail(s))}
          className="nt-inventory-detail-btn"
          aria-label={`View authentication source ${s.name}`}
        >
          {s.name}
        </button>
      ),
    },
    {
      key: 'type',
      title: 'Type',
      sortValue: (s) => s.type ?? '',
      render: (s) => s.type ?? '—',
    },
    {
      key: 'description',
      title: 'Description',
      sortValue: (s) => s.description ?? '',
      render: (s) => s.description ?? '—',
    },
  ];

  return (
    <>
      <SectionHeader label="Authentication sources" meta={inventoryMeta(rows)} />
      <InventoryGate
        rows={rows}
        notReportedDescription="ClearPass did not return its authentication sources this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no authentication sources"
      >
        <DataTable
          ariaLabel="ClearPass authentication sources"
          density={density}
          columns={columns}
          rows={rows ?? []}
          rowKey={(s) => s.id}
          onRowActivate={(s) => onView(authSourceDetail(s))}
        />
      </InventoryGate>
    </>
  );
}

function RolesSection({
  rows,
  density,
  onView,
}: {
  rows: ClearPassRoleRow[] | undefined;
  density: 'comfortable' | 'compact';
  onView: (row: StaticInventoryDetail) => void;
}) {
  const columns: Array<DataTableColumn<ClearPassRoleRow>> = [
    {
      key: 'name',
      title: 'Name',
      hideable: false,
      sortValue: (r) => r.name,
      render: (r) => (
        <button
          type="button"
          onClick={() => onView(roleDetail(r))}
          className="nt-inventory-detail-btn"
          aria-label={`View role ${r.name}`}
        >
          {r.name}
        </button>
      ),
    },
    {
      key: 'description',
      title: 'Description',
      sortValue: (r) => r.description ?? '',
      render: (r) => r.description ?? '—',
    },
  ];

  return (
    <>
      <SectionHeader label="Roles" meta={inventoryMeta(rows)} />
      <InventoryGate
        rows={rows}
        notReportedDescription="ClearPass did not return its role inventory this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no roles"
      >
        <DataTable
          ariaLabel="ClearPass roles"
          density={density}
          columns={columns}
          rows={rows ?? []}
          rowKey={(r) => r.id}
          onRowActivate={(r) => onView(roleDetail(r))}
        />
      </InventoryGate>
    </>
  );
}

function EnforcementSection({
  policies,
  profiles,
  density,
  onView,
}: {
  policies: ClearPassEnforcementPolicyRow[] | undefined;
  profiles: ClearPassEnforcementProfileRow[] | undefined;
  density: 'comfortable' | 'compact';
  onView: (row: StaticInventoryDetail) => void;
}) {
  const policyColumns: Array<DataTableColumn<ClearPassEnforcementPolicyRow>> = [
    {
      key: 'name',
      title: 'Policy',
      hideable: false,
      sortValue: (p) => p.name,
      render: (p) => (
        <button
          type="button"
          onClick={() => onView(enforcementPolicyDetail(p))}
          className="nt-inventory-detail-btn"
          aria-label={`View enforcement policy ${p.name}`}
        >
          {p.name}
        </button>
      ),
    },
    {
      key: 'type',
      title: 'Type',
      sortValue: (p) => p.enforcementType ?? '',
      render: (p) => p.enforcementType ?? '—',
    },
    {
      key: 'defaultProfile',
      title: 'Default profile',
      sortValue: (p) => p.defaultProfile ?? '',
      render: (p) => <DefaultProfileChain policy={p} profiles={profiles} />,
    },
  ];

  const profileColumns: Array<DataTableColumn<ClearPassEnforcementProfileRow>> = [
    {
      key: 'name',
      title: 'Name',
      hideable: false,
      sortValue: (p) => p.name,
      render: (p) => (
        <button
          type="button"
          onClick={() => onView(enforcementProfileDetail(p))}
          className="nt-inventory-detail-btn"
          aria-label={`View enforcement profile ${p.name}`}
        >
          {p.name}
        </button>
      ),
    },
    {
      key: 'type',
      title: 'Type',
      sortValue: (p) => p.type ?? '',
      render: (p) => p.type ?? '—',
    },
    {
      key: 'description',
      title: 'Description',
      sortValue: (p) => p.description ?? '',
      render: (p) => p.description ?? '—',
    },
  ];

  return (
    <>
      <SectionHeader label="Enforcement policies" meta={inventoryMeta(policies)} />
      <InventoryGate
        rows={policies}
        notReportedDescription="ClearPass did not return its enforcement policies this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no enforcement policies"
      >
        <DataTable
          ariaLabel="ClearPass enforcement policies"
          density={density}
          columns={policyColumns}
          rows={policies ?? []}
          rowKey={(p) => p.id}
          onRowActivate={(p) => onView(enforcementPolicyDetail(p))}
        />
      </InventoryGate>

      <SectionHeader label="Enforcement profiles" meta={inventoryMeta(profiles)} />
      <InventoryGate
        rows={profiles}
        notReportedDescription="ClearPass did not return its enforcement profiles this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no enforcement profiles"
      >
        <DataTable
          ariaLabel="ClearPass enforcement profiles"
          density={density}
          columns={profileColumns}
          rows={profiles ?? []}
          rowKey={(p) => p.id}
          onRowActivate={(p) => onView(enforcementProfileDetail(p))}
        />
      </InventoryGate>
    </>
  );
}

/**
 * The policy→default-profile→profile chain: a policy's catch-all names a
 * profile, and when that name resolves to a reported profile row the link
 * shows what the fallback actually returns (type · description). An
 * unresolved name still renders — it is what the policy says — just without
 * a resolution the envelope cannot vouch for.
 */
function DefaultProfileChain({
  policy,
  profiles,
}: {
  policy: ClearPassEnforcementPolicyRow;
  profiles: ClearPassEnforcementProfileRow[] | undefined;
}) {
  if (policy.defaultProfile === null) return <>—</>;
  const profile = profiles?.find((p) => p.name === policy.defaultProfile);
  const detail = profile ? [profile.type, profile.description].filter(Boolean).join(' · ') : '';
  return (
    <div>
      {policy.defaultProfile}
      {detail ? <div className="nt-hint-muted">→ {detail}</div> : null}
    </div>
  );
}

/**
 * Local users — STRICTLY the whitelisted identity fields the adapter maps
 * (login, display name, role, enabled). There is no password material in the
 * payload to render, and this section must never grow a column that would
 * carry any. The add/edit drawers set a password write-only; it is never
 * shown here or anywhere else.
 */
function LocalUsersSection({
  rows,
  density,
  onAdd,
  onEdit,
}: {
  rows: ClearPassLocalUserRow[] | undefined;
  density: 'comfortable' | 'compact';
  onAdd?: () => void;
  onEdit?: (row: ClearPassLocalUserRow) => void;
}) {
  return (
    <>
      <SectionHeader label="Local users" meta={inventoryMeta(rows)} />
      {onAdd ? <div className="nt-row nt-gap-10">
        <Button variant="secondary" size="sm" onClick={onAdd}>
          Add local user
        </Button>
      </div> : null}
      <InventoryGate
        rows={rows}
        notReportedDescription="ClearPass did not return its local users this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no local users"
      >
        <DataTable
          ariaLabel="ClearPass local users"
          density={density}
          columns={[
            {
              key: 'userId',
              title: 'User ID',
              hideable: false,
              render: (u) => <span className="nt-mono-11">{u.userId}</span>,
            },
            { key: 'name', title: 'Name', render: (u) => u.username ?? '—' },
            { key: 'role', title: 'Role', render: (u) => u.roleName ?? '—' },
            {
              key: 'status',
              title: 'Status',
              render: (u) =>
                u.enabled === null ? (
                  '—'
                ) : (
                  <Badge tone={u.enabled ? 'success' : 'neutral'} dot>
                    {u.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                ),
            },
            {
              key: 'edit',
              title: '',
              hideable: false,
              render: (u) =>
                onEdit ? (
                  <Button variant="ghost" size="sm" onClick={() => onEdit(u)} aria-label={`Edit local user ${u.userId}`}>
                    Edit
                  </Button>
                ) : null,
            },
          ] satisfies Array<DataTableColumn<ClearPassLocalUserRow>>}
          rows={rows ?? []}
          rowKey={(u) => u.id}
          rowTone={(u) =>
            u.enabled === null ? 'neutral' : u.enabled ? 'success' : 'warning'
          }
        />
      </InventoryGate>
    </>
  );
}

/**
 * Services and device groups are the collections a CPPM build may not expose
 * at all (the adapter omits the key on a 404, without even a partial flag),
 * so an absent key reads "not available on this CPPM". Device groups stay
 * absent in BOTH modes — the demo estate's CPPM (verified 6.11 behavior)
 * does not serve them. Services populate wherever the box answers either
 * service path — the demo estate's 6.11 CPPM included — with the richer
 * 6.11 shape: enabled state, template, hit count, order, auth sources and a
 * one-line read of the match rules; the not-available state remains for the
 * older builds that 404 both paths.
 *
 * A service row is clickable (the name, or its View action — the screen's
 * row idiom): it opens the per-service detail drawer, which reads the full
 * definition on demand from the route's TTL-cached read.
 */
function ServicesSection({
  services,
  servicesTotal,
  deviceGroups,
  density,
  selectedServiceKeys,
  onServiceSelectionChange,
  onView,
  onViewDeviceGroup,
  selectionFilterActive = false,
  onClearFilters,
}: {
  services: ClearPassServiceRow[] | undefined;
  /** Unfiltered collection length when a filter is active (for honest meta). */
  servicesTotal?: number;
  deviceGroups: ClearPassDeviceGroupRow[] | undefined;
  density: 'comfortable' | 'compact';
  selectedServiceKeys: string[];
  onServiceSelectionChange: (keys: string[]) => void;
  onView: (row: ClearPassServiceRow) => void;
  onViewDeviceGroup: (row: StaticInventoryDetail) => void;
  /** True while a `?services=` selection deep-link is narrowing the table. */
  selectionFilterActive?: boolean;
  /** Reset services search / enabled filters (Loop 222 empty filter CTA). */
  onClearFilters?: () => void;
}) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const filteredMeta =
    services === undefined
      ? 'NOT AVAILABLE'
      : servicesTotal !== undefined && servicesTotal !== services.length
        ? `${services.length} of ${servicesTotal}`
        : `${services.length}`;
  return (
    <>
      <div className="nt-row-between">
        <SectionHeader label="Services" meta={filteredMeta} />
        {services && services.length > 0 ? (
          <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
        ) : null}
      </div>
      {services === undefined ? (
        <EmptyState
          title="Services are not available on this CPPM"
          description="This CPPM answered 404 on both /api/config/service and /api/service — the section is absent, not empty. Nothing about the portal's read is broken."
        />
      ) : services.length === 0 ? (
        <EmptyState
          title={
            servicesTotal && servicesTotal > 0
              ? selectionFilterActive
                ? 'No services match this selection'
                : 'Nothing matches that filter'
              : 'ClearPass reports no services'
          }
          description={
            servicesTotal && servicesTotal > 0
              ? selectionFilterActive
                ? 'Clear the selection filter to restore the services list under the current search / enabled filters.'
                : 'Loosen the search or enabled filter to widen the services list.'
              : undefined
          }
        >
          {servicesTotal && servicesTotal > 0 && selectionFilterActive ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('services');
                setSearchParams(next, { replace: true });
                onServiceSelectionChange([]);
              }}
            >
              Clear selection filter
            </Button>
          ) : servicesTotal && servicesTotal > 0 && !selectionFilterActive && onClearFilters ? (
            <Button variant="secondary" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <DataTable
            ariaLabel="ClearPass services"
            density={density}
            columns={serviceColumns(onView)}
            rows={services}
            rowKey={(s) => s.id}
            selectedKeys={selectedServiceKeys}
            onSelectionChange={onServiceSelectionChange}
            onRowActivate={onView}
            rowTone={(s) =>
              s.enabled === null || s.enabled === undefined
                ? 'neutral'
                : s.enabled
                  ? 'success'
                  : 'warning'
            }
          />
          {selectedServiceKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Service selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedServiceKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy names, or share a selection link for only the services you marked — full list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedServiceKeys);
                    const picked = services.filter((s) => selected.has(s.id));
                    if (picked.length === 0) {
                      toast('No selected services still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'clearpass-services-selected.csv',
                      [
                        'id',
                        'name',
                        'type',
                        'description',
                        'template',
                        'enabled',
                        'hitCount',
                        'orderNo',
                        'authSources',
                        'rulesSummary',
                      ],
                      picked.map((s) => [
                        s.id ?? '',
                        s.name ?? '',
                        s.type ?? '',
                        s.description ?? '',
                        s.template ?? '',
                        s.enabled === true ? 'yes' : s.enabled === false ? 'no' : '',
                        s.hitCount == null ? '' : String(s.hitCount),
                        s.orderNo == null ? '' : String(s.orderNo),
                        (s.authSources ?? []).join('; '),
                        s.rulesSummary ?? '',
                      ]),
                    );
                    toast(`Exported ${countOf(n, 'selected service')}`, {
                      description: 'clearpass-services-selected.csv — policy fields only.',
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
                      const selected = new Set(selectedServiceKeys);
                      const picked = services.filter((s) => selected.has(s.id));
                      if (picked.length === 0) {
                        toast('No selected services still in view', {
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
                        toast('No names on the selected services', {
                          description: 'Those rows did not publish a name — export CSV for ids instead.',
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
                      const selected = new Set(selectedServiceKeys);
                      const picked = services.filter((s) => selected.has(s.id));
                      if (picked.length === 0) {
                        toast('No selected services still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const ids = [
                        ...new Set(
                          picked
                            .map((s) => (s.id ?? '').trim())
                            .filter((id) => id && id !== '—'),
                        ),
                      ];
                      if (ids.length === 0) {
                        toast('No ids on the selected services', {
                          description: 'Those rows did not publish an id — export CSV for names instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('services', ids.join('\n'));
                      next.set('tab', 'services');
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${ids.length} service${ids.length === 1 ? '' : 's'} · services=`,
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
                <Button variant="ghost" size="sm" onClick={() => onServiceSelectionChange([])}>
                  Clear
                </Button>
              </span>
            </div>
          ) : null}
        </>
      )}

      <SectionHeader label="Device groups" meta={deviceGroups === undefined ? 'NOT AVAILABLE' : `${deviceGroups.length}`} />
      {deviceGroups === undefined ? (
        <EmptyState
          title="Device groups are not available on this CPPM"
          description="This CPPM build does not expose /api/device-group — the section is absent, not empty. Nothing about the portal's read is broken."
        />
      ) : deviceGroups.length === 0 ? (
        <EmptyState title="ClearPass reports no device groups" />
      ) : (
        <DataTable
          ariaLabel="ClearPass device groups"
          density={density}
          columns={deviceGroupColumns(onViewDeviceGroup)}
          rows={deviceGroups}
          rowKey={(g) => g.id}
          onRowActivate={(g) => onViewDeviceGroup(deviceGroupDetail(g))}
        />
      )}
    </>
  );
}

function serviceColumns(
  onView: (row: ClearPassServiceRow) => void,
): Array<DataTableColumn<ClearPassServiceRow>> {
  return [
    {
      key: 'name',
      title: 'Service',
      hideable: false,
      sortValue: (s) => s.name,
      render: (s) => (
        <div>
          <button
            type="button"
            onClick={() => onView(s)}
            className="nt-mono-link nt-btn-plain-primary nt-font-inherit"
          >
            {s.name}
          </button>
          {s.description ? <div className="nt-hint-muted">{s.description}</div> : null}
        </div>
      ),
    },
    {
      key: 'status',
      title: 'Status',
      sortValue: (s) => (s.enabled === null || s.enabled === undefined ? '' : s.enabled ? 1 : 0),
      render: (s) =>
        s.enabled === null || s.enabled === undefined ? (
          '—'
        ) : (
          <Badge tone={s.enabled ? 'success' : 'neutral'} dot>
            {s.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        ),
    },
    {
      key: 'type',
      title: 'Type',
      sortValue: (s) => s.type ?? '',
      render: (s) => (
        <div>
          {s.type ?? '—'}
          {s.template ? <div className="nt-hint-muted">{s.template}</div> : null}
        </div>
      ),
    },
    {
      key: 'hits',
      title: 'Hits',
      numeric: true,
      sortValue: (s) => s.hitCount ?? -1,
      render: (s) =>
        s.hitCount === null || s.hitCount === undefined ? '—' : formatCount(s.hitCount),
    },
    {
      key: 'order',
      title: 'Order',
      numeric: true,
      sortValue: (s) => s.orderNo ?? -1,
      render: (s) => s.orderNo ?? '—',
    },
    {
      key: 'authSources',
      title: 'Auth sources',
      sortValue: (s) => (s.authSources ?? []).join(', '),
      render: (s) =>
        s.authSources && s.authSources.length > 0 ? s.authSources.join(', ') : '—',
    },
    {
      key: 'rules',
      title: 'Match rules',
      sortValue: (s) => s.rulesSummary ?? '',
      render: (s) => <span className="nt-mono-11">{s.rulesSummary ?? '—'}</span>,
    },
    {
      key: 'view',
      title: 'View',
      hideable: false,
      render: (s) => (
        <Button variant="ghost" size="sm" onClick={() => onView(s)} aria-label={`View service ${s.name}`}>
          View
        </Button>
      ),
    },
  ];
}

function deviceGroupColumns(
  onViewDeviceGroup: (row: StaticInventoryDetail) => void,
): Array<DataTableColumn<ClearPassDeviceGroupRow>> {
  return [
    {
      key: 'name',
      title: 'Name',
      hideable: false,
      sortValue: (g) => g.name,
      render: (g) => (
        <button
          type="button"
          onClick={() => onViewDeviceGroup(deviceGroupDetail(g))}
          className="nt-inventory-detail-btn"
          aria-label={`View device group ${g.name}`}
        >
          {g.name}
        </button>
      ),
    },
    {
      key: 'description',
      title: 'Description',
      sortValue: (g) => g.description ?? '',
      render: (g) => g.description ?? '—',
    },
  ];
}

// ---------------------------------------------------------------------------
// Service detail drawer — ONE service's full definition, read on demand.
//
// CPPM's own service form, read-only: SUMMARY, MATCH RULES, AUTHENTICATION,
// AUTHORIZATION, ENFORCEMENT, OPTIONS. The payload's own verdicts drive the
// body — 'ok' renders the object, 'empty' is the box's 404 (no such
// service), 'failed' is a broken read — and a field the box did not report
// renders 'Not reported', never an invented value. Nothing in a service
// definition is credential material, and this drawer must never grow a row
// that would carry any.
// ---------------------------------------------------------------------------

/** A tri-state flag as CPPM words its own toggles; null is "the box did not say". */
function flagText(value: boolean | null): string {
  return value === null ? 'Not reported' : value ? 'Enabled' : 'Disabled';
}

/** rules_match_type as CPPM's rule editor words it; an unfamiliar value passes through. */
function matchTypeLabel(value: string | null): string {
  if (value === null) return 'Not reported';
  if (value === 'MATCHES_ALL') return 'Matches ALL of the following conditions';
  if (value === 'MATCHES_ANY') return 'Matches ANY of the following conditions';
  return value;
}

/** The drawer's body for one settled read — the three route outcomes first. */
function ServiceDetailBody({ result }: { result: ClearPassServiceDetailResult }) {
  if (result.kind === 'not-reported') {
    return (
      <div className="nt-service-note">
        No detail was reported for this service — the portal has no service read for this id.
      </div>
    );
  }
  if (result.kind === 'failed') {
    return (
      <div className="nt-service-note nt-danger-text">
        The service detail read failed — {result.message}
      </div>
    );
  }
  const { detail } = result;
  const state = detailState(detail.source, 'service');
  const provenance = `CLEARPASS · READ ${hhmmLocal(detail.source.at)}${detail.source.cached ? ' · CACHED' : ''}`;
  if (state === 'failed') {
    return (
      <div className="nt-stack nt-gap-16">
        <div className="nt-service-note nt-hint-muted">{provenance}</div>
        <div className="nt-service-note nt-danger-text">
          The service read failed{detail.source.note ? ` — ${detail.source.note}` : ''}.
        </div>
      </div>
    );
  }
  if (state === 'empty' || detail.service === null) {
    return (
      <div className="nt-stack nt-gap-16">
        <div className="nt-service-note nt-hint-muted">{provenance}</div>
        <div className="nt-service-note">
          {detail.source.note ?? 'ClearPass answered 404 for this service — no such service on this CPPM.'}
        </div>
      </div>
    );
  }
  return <ServiceDefinition detail={detail} />;
}

/** The mapped service, sectioned the way CPPM's own service form sections it. */
function ServiceDefinition({ detail }: { detail: ClearPassServiceDetailLive }) {
  const s = detail.service;
  if (s === null) return null; // unreachable past ServiceDetailBody's gate — never render a guessed object
  return (
    <div className="nt-stack nt-gap-22">
      <div className="nt-service-note nt-hint-muted">
        {`CLEARPASS · READ ${hhmmLocal(detail.source.at)}${detail.source.cached ? ' · CACHED' : ''}`}
      </div>

      <div className="nt-stack nt-gap-2">
        <SectionHeader label="Summary" />
        <ReviewRow label="Name" value={s.name} />
        <ReviewRow label="ID" value={s.id} mono />
        <ReviewRow label="Type" value={s.type ?? 'Not reported'} />
        <ReviewRow label="Template" value={s.template ?? 'Not reported'} />
        <ReviewRow label="Order" value={s.orderNo !== null ? String(s.orderNo) : 'Not reported'} />
        <ReviewRow label="Status" value={flagText(s.enabled)} />
        <ReviewRow label="Hit count" value={s.hitCount !== null ? formatCount(s.hitCount) : 'Not reported'} />
        <ReviewRow label="Description" value={s.description ?? 'Not reported'} />
        <ReviewRow label="Monitor mode" value={flagText(s.monitorMode)} />
      </div>

      <div className="nt-stack nt-gap-8">
        <SectionHeader label="Match rules" />
        <ReviewRow label="Match type" value={matchTypeLabel(s.rulesMatchType)} />
        {s.rulesConditions.length > 0 ? (
          <DataTable
            density="compact"
            className="nt-plane-table"
            ariaLabel="ClearPass match rule conditions"
            rowKey={(c, i) => `${c.type ?? ''}:${c.name ?? ''}:${i}`}
            columns={
              [
                {
                  key: 'type',
                  title: 'Type',
                  render: (c) => c.type ?? '—',
                },
                {
                  key: 'name',
                  title: 'Name',
                  render: (c) => c.name ?? '—',
                },
                {
                  key: 'operator',
                  title: 'Operator',
                  render: (c) => <span className="nt-mono-11">{c.operator ?? '—'}</span>,
                },
                {
                  key: 'value',
                  title: 'Value',
                  render: (c) => <span className="nt-mono-11">{c.value ?? '—'}</span>,
                },
              ] satisfies Array<
                DataTableColumn<{
                  type?: string | null;
                  name?: string | null;
                  operator?: string | null;
                  value?: string | null;
                }>
              >
            }
            rows={s.rulesConditions}
          />
        ) : (
          <div className="nt-service-note">No match conditions were reported for this service.</div>
        )}
      </div>

      <div className="nt-stack nt-gap-2">
        <SectionHeader label="Authentication" />
        <ReviewRow label="Methods" value={s.authMethods.length > 0 ? s.authMethods.join(', ') : 'Not reported'} />
        <ReviewRow label="Sources" value={s.authSources.length > 0 ? s.authSources.join(', ') : 'Not reported'} />
        <ReviewRow label="Strip username" value={flagText(s.stripUsername)} />
      </div>

      <div className="nt-stack nt-gap-2">
        <SectionHeader label="Authorization" />
        <ReviewRow label="Role mapping" value={s.roleMappingPolicy ?? 'Not reported'} />
      </div>

      <div className="nt-stack nt-gap-2">
        <SectionHeader label="Enforcement" />
        <ReviewRow label="Policy" value={s.enforcementPolicy ?? 'Not reported'} />
      </div>

      <div className="nt-stack nt-gap-2">
        <SectionHeader label="Options" />
        <ReviewRow label="Posture" value={flagText(s.postureEnabled)} />
        <ReviewRow label="Audit" value={flagText(s.auditEnabled)} />
        <ReviewRow label="Profiler" value={flagText(s.profilerEnabled)} />
        <ReviewRow label="Accounting proxy" value={flagText(s.acctProxyEnabled)} />
        <ReviewRow label="Cached results" value={flagText(s.useCachedPolicyResults)} />
      </div>
    </div>
  );
}

/**
 * The per-service read drawer. Mounts only while open and keyed by the
 * service id, so the fetch fires once per opening and its state starts
 * fresh — the server TTL-caches, so a reopen inside the window costs no
 * CPPM call.
 */
function ServiceDetailDrawer({
  row,
  onOpenChange,
}: {
  row: ClearPassServiceRow;
  onOpenChange: (open: boolean) => void;
}) {
  const [result, setResult] = useState<ClearPassServiceDetailResult | null>(null);

  useEffect(() => {
    let live = true;
    void getClearPassServiceDetail(row.id)
      .then((r) => {
        if (live) setResult(r);
      })
      .catch(() => {
        if (live) setResult({ kind: 'failed', message: 'the service detail request failed' });
      });
    return () => {
      live = false;
    };
  }, [row.id]);

  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      width="lg"
      title={row.name}
      description="The service definition as ClearPass reports it — summary, match rules, authentication, authorization, enforcement and options."
    >
      {result === null ? (
        <div className="nt-center-pad nt-pad-48">
          <div role="status" aria-label="NightDesk · loading ClearPass" className="nt-stack nt-gap-8 nt-debug-wake nt-debug-wake--compact">
            <Skeleton height={14} width="36%" />
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        </div>
      ) : (
        <ServiceDetailBody result={result} />
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Reviewed write drawers — endpoint register/edit and local-user create/edit.
//
// Every drawer is the same contract the SSID editor set: the form, then an
// exact summary of what will be written (a password is NEVER in it), then an
// explicit review checkbox standing in for a ticket, then the server's
// apply→verify→audit outcome shown verbatim. Apply stays disabled while the
// form would be refused or nothing changed. Demo mode applies the write to
// the fixture world on screen (the result message says plainly that nothing
// left the portal); live mode re-fetches the screen so the list reflects the
// plane, and the outcome says when the server could not re-read it.
// ---------------------------------------------------------------------------

/** Client-side mirror of the server's MAC rule — the server stays authoritative. */
function macProblem(mac: string): string | null {
  if (!mac.trim()) return 'a MAC address is required';
  return mac.trim().replace(/[^0-9a-fA-F]/g, '').length === 12
    ? null
    : 'a valid MAC address is 12 hex digits (any separator) — e.g. 3c:22:fb:41:0a:19';
}

/** The attributes textarea, one 'Name: Value' per line → CPPM's flat map. */
function parseAttributes(text: string): { attributes?: Record<string, string>; problem?: string } {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (!line) continue;
    const idx = line.indexOf(':');
    const key = idx > 0 ? line.slice(0, idx).trim() : '';
    const value = idx > 0 ? line.slice(idx + 1).trim() : '';
    if (!key || !value) return { problem: `attribute line '${line}' must be Name: Value` };
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? { attributes: out } : {};
}

/** The fixture-world row a demo registration adds — clearly a demo artifact
 *  ('just now (demo)'), matching the whitelisted shape every other row has. */
function demoEndpointRowFor(form: ClearPassEndpointRegisterForm): EndpointRow {
  return {
    id: `demo-ep-${normalizeMac(form.mac)}`,
    mac: normalizeMac(form.mac),
    description: form.description ?? null,
    ip: null,
    hostname: null,
    status: form.status ?? 'Known',
    category: form.attributes?.Category ?? null,
    family: form.attributes?.Family ?? null,
    os: form.attributes?.OS ?? null,
    profile: null,
    updatedAt: 'just now (demo)',
  };
}

/** The fixture-world row a demo local-user create adds — whitelisted identity
 *  fields only, exactly like the rows the plane reports. */
function demoLocalUserRowFor(form: ClearPassLocalUserCreateForm): ClearPassLocalUserRow {
  return {
    id: `demo-lu-${form.userId}`,
    userId: form.userId,
    username: form.username ?? null,
    roleName: form.roleName,
    enabled: form.enabled,
  };
}

/** One row of the 'What gets written' review summary. */
function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      className="nt-row-baseline nt-rule-row-sm nt-row nt-items-baseline nt-gap-10"
    >
      <span className="nt-fact-row__k nt-w-110">{label}</span>
      <span
        className={mono ? "nt-fact-body nt-fact-body--mono nt-mono-11" : "nt-fact-body"}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The apply outcome, rendered verbatim from the server. Green is a claim: a
 * write CPPM answered but the read-back could not confirm does not get one —
 * the same rule the SSID apply's result panel follows.
 */
function WriteOutcomeAlert({ outcome }: { outcome: { error?: string; result?: ClearPassWriteResult } }) {
  if (outcome.error) {
    return (
      <Alert tone="danger" title="Apply failed">
        <span className="nt-body-sm">{outcome.error}</span>
      </Alert>
    );
  }
  const r = outcome.result;
  if (!r) return null;
  const stale = r.cacheRefresh?.attempted === true && !r.cacheRefresh.ok;
  const tone = !r.ok ? 'danger' : r.verified === true && !stale ? 'success' : 'warning';
  const title = !r.ok
    ? 'Not applied'
    : r.verified === true
      ? stale
        ? 'Applied and confirmed — the list could not be re-read'
        : r.action === 'created'
          ? 'Applied and confirmed'
          : 'Updated and confirmed'
      : 'Applied, not confirmed by the read-back';
  return (
    <Alert tone={tone} title={title}>
      <div className="nt-stack-col nt-gap-6 nt-fs-13">
        <span>{r.message}</span>
        {stale ? (
          <span>
            The list behind could not be re-read ({r.cacheRefresh?.message ?? 'reason not reported'}) — it may not
            show this yet. Do not apply it again.
          </span>
        ) : null}
      </div>
    </Alert>
  );
}

/** The review checkbox, the apply/cancel row, the outcome, and the audit note —
 *  one footer every write drawer shares. */
function ReviewedWriteFooter({
  lab,
  reviewed,
  onReviewed,
  problems,
  applying,
  applyLabel,
  onApply,
  onCancel,
  outcome,
}: {
  lab: boolean;
  reviewed: boolean;
  onReviewed: (v: boolean) => void;
  problems: string[];
  applying: boolean;
  applyLabel: string;
  onApply: () => Promise<void>;
  onCancel: () => void;
  outcome: { error?: string; result?: ClearPassWriteResult } | null;
}) {
  return (
    <div className="nt-stack nt-gap-10">
      {!lab ? <Checkbox
        label="I have reviewed this write — apply directly, no ticket."
        checked={reviewed}
        onChange={(e) => onReviewed(e.target.checked)}
      /> : null}
      {problems.length > 0 ? (
        <Alert tone="warning" title="Apply is disabled — the form would be refused">
          <div className="nt-stack nt-gap-4 nt-fs-13">
            {problems.map((p) => (
              <span key={p}>{p}</span>
            ))}
          </div>
        </Alert>
      ) : null}
      <div className="nt-filter-bar nt-gap-8">
        <Button
          variant="primary"
          size="md"
          disabled={(!lab && !reviewed) || applying || problems.length > 0}
          onClick={() => void onApply()}
        >
          {applying ? 'Applying…' : applyLabel}
        </Button>
        <Button variant="ghost" size="md" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {outcome ? <WriteOutcomeAlert outcome={outcome} /> : null}
      <span
        className="nt-hint-muted nt-lh-16"
      >
        Direct apply — no ticket, no queue. An audit event is still recorded for every attempt.
      </span>
    </div>
  );
}

/** Toast wording for a landed write — confirmed reads differently from
 *  answered-but-unverified, and a stale cache says so outright. */
function toastWriteOutcome(
  toast: ReturnType<typeof useToast>['toast'],
  label: string,
  r: ClearPassWriteResult,
): void {
  const confirmed = r.verified === true;
  const stale = r.cacheRefresh?.attempted === true && !r.cacheRefresh.ok;
  toast(confirmed && !stale ? `${label} applied` : `${label} applied — not fully confirmed`, {
    description: r.message + (stale ? ' The list may not show it yet — do not apply it again.' : ''),
    tone: confirmed && !stale ? 'success' : 'warning',
  });
}

/** 'Register endpoint' — POST /api/endpoint through the reviewed flow. Mounted
 *  only while open, so a fresh form is just a fresh mount. */
function RegisterEndpointDrawer({
  onOpenChange,
  demo,
  lab,
  onDemoApplied,
  reload,
  reloadEndpointPage,
}: {
  onOpenChange: (open: boolean) => void;
  demo: boolean;
  lab: boolean;
  onDemoApplied: (form: ClearPassEndpointRegisterForm) => void;
  reload: () => Promise<void>;
  reloadEndpointPage: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [mac, setMac] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ClearPassEndpointStatus>('Known');
  const [attrText, setAttrText] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ error?: string; result?: ClearPassWriteResult } | null>(null);

  const parsed = parseAttributes(attrText);
  const problems = [macProblem(mac), parsed.problem ?? null].filter((p): p is string => p !== null);

  const apply = async () => {
    if ((!lab && !reviewed) || applying || problems.length > 0) return;
    const form: ClearPassEndpointRegisterForm = {
      mac: mac.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      status,
      ...(parsed.attributes ? { attributes: parsed.attributes } : {}),
    };
    setApplying(true);
    const r = await registerClearPassEndpoint(form, lab ? undefined : true);
    setApplying(false);
    if (isApiError(r)) {
      setOutcome({ error: r.error });
      toast(r.error, { tone: 'danger' });
      return;
    }
    setOutcome({ result: r });
    if (r.ok) {
      toastWriteOutcome(toast, normalizeMac(form.mac), r);
      if (demo) onDemoApplied(form);
      else await Promise.all([reload(), reloadEndpointPage()]);
    } else {
      toast(`${normalizeMac(form.mac)} was not registered`, { description: r.message, tone: 'danger' });
    }
  };

  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      width="lg"
      className="nd-drawer--write-ritual nt-write-ritual"
      title="Register endpoint"
      description={`Add one MAC to the ClearPass endpoint repository, with the profiling attributes you know. ${lab ? 'This lab write applies directly.' : 'The write goes to the linked CPPM only after your explicit review.'}`}
    >
      <div className="nt-stack nt-gap-16">
        <div className="nt-write-ritual nt-write-ritual--banner" aria-hidden />
        <FormField label="MAC address" help="Any separator — normalised to aa:bb:cc:dd:ee:ff before the write.">
          <Input mono value={mac} onChange={(e) => setMac(e.target.value)} placeholder="3c:22:fb:41:0a:19" />
        </FormField>
        <FormField label="Description" help="The operator note shown in the repository — optional.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ward 3E infusion pump" />
        </FormField>
        <FormField label="Status">
          <Select
            options={CLEARPASS_ENDPOINT_STATUSES.map((s) => ({ value: s, label: s }))}
            value={status}
            onValueChange={(v) => setStatus(v as ClearPassEndpointStatus)}
            aria-label="Endpoint status"
          />
        </FormField>
        <FormField label="Attributes" help="Profiling hints, one Name: Value per line — optional.">
          <Textarea
            mono
            rows={3}
            value={attrText}
            onChange={(e) => setAttrText(e.target.value)}
            placeholder={'Category: Computer\nFamily: Embedded'}
          />
        </FormField>

        <div className="nt-stack nt-gap-2">
          <SectionHeader label={lab ? 'Write summary' : 'Review — what gets written'} />
          <ReviewRow label="MAC" value={mac.trim() ? normalizeMac(mac) : '—'} mono />
          <ReviewRow label="Status" value={status} />
          <ReviewRow label="Description" value={description.trim() || '—'} />
          <ReviewRow
            label="Attributes"
            value={
              parsed.attributes
                ? Object.entries(parsed.attributes)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')
                : '—'
            }
            mono={!!parsed.attributes}
          />
          <span className="nt-hint-muted nt-mt-6">
            {demo
              ? 'demo mode — validated and audit-logged here; nothing is sent to a live CPPM.'
              : 'POST /api/endpoint on the linked CPPM, then a read-back to confirm it.'}
          </span>
        </div>

        <ReviewedWriteFooter
          reviewed={reviewed}
          lab={lab}
          onReviewed={setReviewed}
          problems={problems}
          applying={applying}
          applyLabel="Register endpoint"
          onApply={apply}
          onCancel={() => onOpenChange(false)}
          outcome={outcome}
        />
      </div>
    </Drawer>
  );
}

/** Per-endpoint edit — status and/or the operator note (PATCH /api/endpoint/{id}).
 *  Keyed by row id and mounted only while open, so the form seeds itself from
 *  the row on mount. */
function EditEndpointDrawer({
  row,
  onOpenChange,
  demo,
  lab,
  onDemoApplied,
  reload,
  reloadEndpointPage,
}: {
  row: EndpointRow;
  onOpenChange: (open: boolean) => void;
  demo: boolean;
  lab: boolean;
  onDemoApplied: (row: EndpointRow, form: ClearPassEndpointUpdateForm) => void;
  reload: () => Promise<void>;
  reloadEndpointPage: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [status, setStatus] = useState<ClearPassEndpointStatus>(() =>
    (CLEARPASS_ENDPOINT_STATUSES as string[]).includes(row.status) ? (row.status as ClearPassEndpointStatus) : 'Known',
  );
  const [description, setDescription] = useState(row.description ?? '');
  const [reviewed, setReviewed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ error?: string; result?: ClearPassWriteResult } | null>(null);

  const statusChanged = status !== row.status;
  const descChanged = description !== (row.description ?? '');
  const problems = statusChanged || descChanged ? [] : ['change the status or the description — there is nothing to write'];
  // Only what actually changed crosses — an untouched status is never
  // rewritten, so a row whose status sits outside the three-value write
  // vocabulary keeps it unless the operator deliberately moves it.
  const statusOptions = (CLEARPASS_ENDPOINT_STATUSES as string[]).includes(row.status)
    ? CLEARPASS_ENDPOINT_STATUSES.map((s) => ({ value: s, label: s }))
    : [...CLEARPASS_ENDPOINT_STATUSES.map((s) => ({ value: s, label: s })), { value: row.status, label: `${row.status} (current)` }];

  const apply = async () => {
    if ((!lab && !reviewed) || applying || problems.length > 0) return;
    const form: ClearPassEndpointUpdateForm = {
      ...(statusChanged ? { status } : {}),
      ...(descChanged ? { description } : {}),
    };
    setApplying(true);
    const r = await updateClearPassEndpoint(row.id, form, lab ? undefined : true);
    setApplying(false);
    if (isApiError(r)) {
      setOutcome({ error: r.error });
      toast(r.error, { tone: 'danger' });
      return;
    }
    setOutcome({ result: r });
    if (r.ok) {
      toastWriteOutcome(toast, row.mac, r);
      if (demo) onDemoApplied(row, form);
      else await Promise.all([reload(), reloadEndpointPage()]);
    } else {
      toast(`${row.mac} was not updated`, { description: r.message, tone: 'danger' });
    }
  };

  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      width="lg"
      className="nd-drawer--write-ritual nt-write-ritual"
      title={`Edit endpoint ${row.mac}`}
      description="Change the repository status and/or the operator note. The MAC is the endpoint's identity and is never rewritten."
    >
      <div className="nt-stack nt-gap-16">
        <div className="nt-write-ritual nt-write-ritual--banner" aria-hidden />
        <FormField label="Status">
          <Select
            options={statusOptions}
            value={status}
            onValueChange={(v) => setStatus(v as ClearPassEndpointStatus)}
            aria-label="Endpoint status"
          />
        </FormField>
        <FormField label="Description" help="Empty clears the operator note.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>

        <div className="nt-stack nt-gap-2">
          <SectionHeader label={lab ? 'Write summary' : 'Review — what gets written'} />
          <ReviewRow label="MAC" value={row.mac} mono />
          <ReviewRow label="Status" value={statusChanged ? `${row.status} → ${status}` : `${status} (unchanged)`} />
          <ReviewRow
            label="Description"
            value={descChanged ? `${row.description ?? '—'} → ${description || '(cleared)'}` : 'unchanged'}
          />
          <span className="nt-hint-muted nt-mt-6">
            {demo
              ? 'demo mode — validated and audit-logged here; nothing is sent to a live CPPM.'
              : `PATCH /api/endpoint/${row.id} on the linked CPPM, then a read-back to confirm it.`}
          </span>
        </div>

        <ReviewedWriteFooter
          reviewed={reviewed}
          lab={lab}
          onReviewed={setReviewed}
          problems={problems}
          applying={applying}
          applyLabel="Apply update"
          onApply={apply}
          onCancel={() => onOpenChange(false)}
          outcome={outcome}
        />
      </div>
    </Drawer>
  );
}

/** Local-user create/edit — role from the reported roles, and a password that
 *  is write-only: never displayed in the review, never echoed in a result.
 *  Keyed by row id (edit) and mounted only while open, so the form seeds
 *  itself on mount. */
function LocalUserWriteDrawer({
  mode,
  row,
  onOpenChange,
  roles,
  demo,
  lab,
  onDemoCreated,
  onDemoUpdated,
  reload,
}: {
  mode: 'create' | 'edit';
  row?: ClearPassLocalUserRow; // edit only — required then
  onOpenChange: (open: boolean) => void;
  roles: ClearPassRoleRow[] | undefined;
  demo: boolean;
  lab: boolean;
  onDemoCreated?: (form: ClearPassLocalUserCreateForm) => void;
  onDemoUpdated?: (row: ClearPassLocalUserRow, form: ClearPassLocalUserUpdateForm) => void;
  reload: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [userId, setUserId] = useState(mode === 'edit' ? (row?.userId ?? '') : '');
  const [username, setUsername] = useState(mode === 'edit' ? (row?.username ?? '') : '');
  const [roleName, setRoleName] = useState(mode === 'edit' ? (row?.roleName ?? '') : '');
  const [enabled, setEnabled] = useState(mode === 'edit' ? (row?.enabled ?? true) : true);
  const [password, setPassword] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ error?: string; result?: ClearPassWriteResult } | null>(null);

  // The pickable roles are the reported dataset; an edit target whose CURRENT
  // role is not in it keeps that role visible (and simply unchanged), exactly
  // like the endpoint editor's out-of-vocabulary status.
  const roleNames = (roles ?? []).map((r) => r.name);
  const roleOptions = [
    ...(mode === 'edit' && roleName && !roleNames.includes(roleName)
      ? [{ value: roleName, label: `${roleName} (current)` }]
      : []),
    ...roleNames.map((n) => ({ value: n, label: n })),
  ];
  const rolesReported = roles !== undefined && roles.length > 0;

  const problems: string[] = [];
  if (mode === 'create') {
    if (!userId.trim()) problems.push('a user id is required');
    if (!roleName) problems.push(rolesReported ? 'pick a role' : 'a role is required, and the role inventory was not reported');
    if (!password) problems.push('a password is required for a new local user');
  } else {
    const changed =
      username !== (row?.username ?? '') ||
      roleName !== (row?.roleName ?? '') ||
      enabled !== (row?.enabled ?? true) ||
      password.length > 0;
    if (!changed) problems.push('change a field, or set a new password — there is nothing to write');
  }
  if (!rolesReported && (mode === 'create' || roleName !== (row?.roleName ?? ''))) {
    problems.push('the role inventory was not reported by this CPPM — a role cannot be picked; resync and reopen');
  }

  const apply = async () => {
    if ((!lab && !reviewed) || applying || problems.length > 0) return;
    if (mode === 'edit' && !row) return;
    setApplying(true);
    let r: Awaited<ReturnType<typeof createClearPassLocalUser>>;
    if (mode === 'create') {
      const form: ClearPassLocalUserCreateForm = {
        userId: userId.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
        roleName,
        enabled,
        password,
      };
      r = await createClearPassLocalUser(form, lab ? undefined : true);
      if (!isApiError(r) && r.ok) {
        if (demo) onDemoCreated?.(form);
        else await reload();
      }
    } else {
      const form: ClearPassLocalUserUpdateForm = {
        ...(username !== ((row as ClearPassLocalUserRow).username ?? '') ? { username } : {}),
        ...(roleName !== ((row as ClearPassLocalUserRow).roleName ?? '') ? { roleName } : {}),
        ...(enabled !== ((row as ClearPassLocalUserRow).enabled ?? true) ? { enabled } : {}),
        ...(password.length > 0 ? { password } : {}),
      };
      r = await updateClearPassLocalUser((row as ClearPassLocalUserRow).id, form, lab ? undefined : true);
      if (!isApiError(r) && r.ok) {
        if (demo) onDemoUpdated?.(row as ClearPassLocalUserRow, form);
        else await reload();
      }
    }
    setApplying(false);
    if (isApiError(r)) {
      setOutcome({ error: r.error });
      toast(r.error, { tone: 'danger' });
      return;
    }
    setOutcome({ result: r });
    const label = mode === 'create' ? userId.trim() : (row?.userId ?? 'local user');
    if (r.ok) toastWriteOutcome(toast, label, r);
    else toast(`${label} was not ${mode === 'create' ? 'created' : 'updated'}`, { description: r.message, tone: 'danger' });
    if (r.ok) setPassword(''); // a written password never lingers in the form
  };

  const title = mode === 'create' ? 'Add local user' : `Edit local user ${row?.userId ?? ''}`;
  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      width="lg"
      className="nd-drawer--write-ritual nt-write-ritual"
      title={title}
      description="A ClearPass local account. The password is write-only: it is sent to CPPM and never displayed, echoed, or read back — including here."
    >
      <div className="nt-stack nt-gap-16">
        <div className="nt-write-ritual nt-write-ritual--banner" aria-hidden />
        {mode === 'create' ? (
          <FormField label="User ID" help="The login name — it cannot be changed afterwards.">
            <Input mono value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="noc-operator" />
          </FormField>
        ) : null}
        <FormField label="Display name" help="Optional.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="NOC Operator" />
        </FormField>
        <FormField label="Role">
          {rolesReported ? (
            <Select
              options={[{ value: '', label: 'Select a role…' }, ...roleOptions]}
              value={roleName}
              onValueChange={setRoleName}
              aria-label="Role"
            />
          ) : (
            <span className="nt-body-sm nt-hint-muted">
              Not reported by this CPPM — a role cannot be picked.
            </span>
          )}
        </FormField>
        <FormField label="Account state">
          <Switch checked={enabled} onCheckedChange={setEnabled} label={enabled ? 'Enabled' : 'Disabled'} />
        </FormField>
        <FormField
          label={mode === 'create' ? 'Password' : 'New password'}
          help={mode === 'create' ? 'Write-only — never shown again, anywhere.' : 'Leave blank to keep the current password.'}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>

        <div className="nt-stack nt-gap-2">
          <SectionHeader label={lab ? 'Write summary' : 'Review — what gets written'} />
          <ReviewRow label="User ID" value={mode === 'create' ? userId.trim() || '—' : (row?.userId ?? '—')} mono />
          <ReviewRow
            label="Display name"
            value={
              mode === 'create'
                ? username.trim() || '—'
                : username !== (row?.username ?? '')
                  ? `${row?.username ?? '—'} → ${username || '(cleared)'}`
                  : 'unchanged'
            }
          />
          <ReviewRow
            label="Role"
            value={
              mode === 'create'
                ? roleName || '—'
                : roleName !== (row?.roleName ?? '')
                  ? `${row?.roleName ?? '—'} → ${roleName}`
                  : roleName || 'unchanged'
            }
          />
          <ReviewRow
            label="State"
            value={
              mode === 'create'
                ? enabled
                  ? 'Enabled'
                  : 'Disabled'
                : enabled !== (row?.enabled ?? true)
                  ? `${row?.enabled ? 'Enabled' : 'Disabled'} → ${enabled ? 'Enabled' : 'Disabled'}`
                  : 'unchanged'
            }
          />
          <ReviewRow label="Password" value={password ? 'set — write-only, never displayed' : mode === 'create' ? '—' : 'unchanged'} />
          <span className="nt-hint-muted nt-mt-6">
            {demo
              ? 'demo mode — validated and audit-logged here; nothing is sent to a live CPPM.'
              : mode === 'create'
                ? 'POST /api/local-user on the linked CPPM, then a whitelisted read-back (never the password).'
                : `PUT /api/local-user/${row?.id ?? ''} on the linked CPPM, then a whitelisted read-back (never the password).`}
          </span>
        </div>

        <ReviewedWriteFooter
          reviewed={reviewed}
          lab={lab}
          onReviewed={setReviewed}
          problems={problems}
          applying={applying}
          applyLabel={mode === 'create' ? 'Create local user' : 'Apply update'}
          onApply={apply}
          onCancel={() => onOpenChange(false)}
          outcome={outcome}
        />
      </div>
    </Drawer>
  );
}
