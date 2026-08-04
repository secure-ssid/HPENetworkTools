/**
 * web/src/screens/Systems.tsx — connected systems (the live one).
 * High-fidelity port of design/NtSystems.dc.html, with the descriptors from
 * getSystems() MERGED with live per-plane registry state from
 * getSystemsState() (GET /api/systems/state) — but only when the systems
 * section is actually live-sourced (dataSource 'live', or blended): a demo
 * payload is authored data and renders as authored, never stamped with the
 * empty registry ("unlinked / never / 0" beside a fixture device count).
 * Roster triage ships **Health** chips (`?health=`) and **Linked** chips
 * (`?linked=1|0`) beside the matching Selects (Loop 139 / 145).
 * On a live section the state Badge shows the registry health
 * (healthy/degraded/warning/unlinked) plus an `unverified` marker when the
 * registry's own age-based `stale` flag is set, the fact strip overrides Last
 * sync / the plane's count fact / Calls today (against the plane's served
 * callBudget) with live values, the throttling Alert is derived from the
 * plane's own 429s, the drawer's Activity tab lists the real recent-call log
 * and names the consecutive-failure/retry state, and Sync history comes from
 * the poller.
 * Backend unreachable → fixture-only plus a small mono "backend offline —
 * fixture state" note. The header carries the envelope's own provenance stamp
 * (DEMO FIXTURE vs LIVE · SYNCED hh:mm) plus a **LIVE** badge on pure live and
 * systems blend (Loop 169 — mono stamp alone is easy to miss). Plane roster
 * multi-select raises **Export selected**, **Copy plane ids**, **Copy names**
 * (unique newline-joined plane display names when registry ids alone are sparse
 * for a handoff — Devices pattern; Loop 229), and **Copy selection link**
 * (`?ids=` of registry plane ids — Sites pattern; clearable chip — Loop 189);
 * drawer open stays on `?plane=` and is independent of bulk marks. Roster filter
 * empties offer **Clear filters** (Loop 202). Selection-empty `?ids=` offers
 * **Clear selection filter** (Loop 219). The Planes meta counts what is actually
 * on screen, never a literal.
 * The stamp is kept honest by polling on the settings cadence (the Overview
 * pattern, one fetch at a time) — suspended while the connect drawer is open,
 * because a refresh must never disturb in-flight credential entry or a
 * connection test. A drawer site row that names a real site drills into it
 * (closing the drawer first).
 * The connect drawer renders the endpoint variant plus the per-plane
 * credential fields the chosen adapter needs (shared CONNECT_FIELDS) and
 * saves every value under the settings key that adapter's isComplete()
 * reads (CONNECT_ENDPOINT_KEY) — a record under any other key links a plane
 * to a stub that never syncs.
 * Mutations are real: Test connection POSTs the entered credentials to
 * /api/systems/:plane/test and surfaces the server's message verbatim (a 502
 * {ok:false,message} is a normal result); Save and index is gated on a
 * successful test and POSTs /api/systems/:plane/credentials; Retire plane
 * DELETEs /api/systems/:plane after a window.confirm. "Open console" opens
 * the row's own SystemRow.consoleUrl in a new tab and is DISABLED for a plane
 * that records none (the local switch collector has no console) — an inert
 * control, never a toast claiming a hand-off the portal cannot make.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  ConfirmDialog,
  Divider,
  Drawer,
  FormField,
  Input,
  SectionHeader,
  SegmentedControl,
  Select,
  PageSkeleton,
  useToast,
} from '../nightdesk';
import {
  getSystems,
  getSystemsState,
  retireSystem,
  saveSystemCredentials,
  syncSystems,
  testSystem,
} from '../api/client';
import type {
  SystemsData,
  SystemsState,
} from '../api/client';
import {
  CONNECTOR_CATALOG,
  connectorCatalogEntry,
  hhmmLocal as hhmm,
  countOf,
} from '@hpe/shared';
import type {
  ConnectorAuth,
  ConnectorAuthField,
  ConnectorAuthKind,
  ConnectorConfig,
  ConnectorId,
  SystemRow,
  SystemTypeKey,
} from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ApiErrorState } from './ApiErrorState';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { useSettings } from '../app/SettingsContext';
import { namesFilterForParam } from '../app/nav';
import { SseInventoryPanel } from './SseInventoryPanel';
import { CentralWebhooksPanel } from './CentralWebhooksPanel';
import { MistSection } from './systems/MistSection';
import { AssistantSection } from './systems/AssistantSection';
import { IdentityProviderSection } from './systems/IdentityProviderSection';
import { NotificationsSection } from './systems/NotificationsSection';
import { RuntimeDebugSection } from './systems/RuntimeDebugSection';
import {
  NothingReported,
  PlaneRow,
  callsFor,
  historyRows,
  throttleBanner,
  pollFailureBanner,
} from './systems/PlaneRow';
import { PortalSection } from './systems/PortalSection';
import { parseSystemsSection, systemsSectionDomId } from './systems/share';
import {
  DetailTab,
  HEALTH_TONE,
  PLANE_ID_BY_NAME,
  PlaneView,
  TAB_OPTIONS,
  countFact,
  factValue,
  mergedFacts,
  retryNote,
  staleTitle,
  storedEndpoint,
  storedScopes,
} from './systems/facts';

/** Roster triage filters — same vocabulary as GET /api/systems/export. */
export const SYSTEMS_HEALTH_FILTERS = [
  { value: 'all', label: 'All health' },
  { value: 'healthy', label: 'Healthy' },
  { value: 'warning', label: 'Warning' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'unlinked', label: 'Unlinked' },
] as const;

export const SYSTEMS_LINKED_FILTERS = [
  { value: 'all', label: 'Linked + unlinked' },
  { value: '1', label: 'Linked only' },
  { value: '0', label: 'Unlinked only' },
] as const;

export type SystemsHealthFilter = (typeof SYSTEMS_HEALTH_FILTERS)[number]['value'];
export type SystemsLinkedFilter = (typeof SYSTEMS_LINKED_FILTERS)[number]['value'];

export function parseSystemsHealthFilter(raw: string | null): SystemsHealthFilter {
  const v = raw?.trim().toLowerCase() ?? '';
  if (v === 'healthy' || v === 'warning' || v === 'degraded' || v === 'unlinked') return v;
  return 'all';
}

export function parseSystemsLinkedFilter(raw: string | null): SystemsLinkedFilter {
  const v = raw?.trim().toLowerCase() ?? '';
  if (v === '1' || v === 'true') return '1';
  if (v === '0' || v === 'false') return '0';
  return 'all';
}

/** Client-side roster match — mirrors server applySystemsRosterFilters. */
export function systemsViewMatchesFilters(
  view: {
    row: { name?: string; kind?: string; scope?: string; state?: string };
    planeId?: string | null;
    stateLabel: string;
    live?: { linked?: boolean } | null;
  },
  opts: { q?: string; health?: SystemsHealthFilter; linked?: SystemsLinkedFilter },
): boolean {
  const healthWant = opts.health && opts.health !== 'all' ? opts.health : '';
  const linkedWant = opts.linked && opts.linked !== 'all' ? opts.linked : '';
  const q = (opts.q ?? '').trim().toLowerCase();
  const health = String(view.stateLabel ?? view.row.state ?? '')
    .trim()
    .toLowerCase();
  const isLinked =
    view.live != null ? view.live.linked === true : health !== '' && health !== 'unlinked';
  if (healthWant && health !== healthWant) return false;
  if (linkedWant === '1' && !isLinked) return false;
  if (linkedWant === '0' && isLinked) return false;
  if (q) {
    const hay = [view.row.name, view.planeId, view.row.kind, view.stateLabel, view.row.scope]
      .map((v) => String(v ?? '').toLowerCase())
      .join(' ');
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Build systems-export query string from the filter bar. */
export function buildSystemsExportQuery(opts: {
  q?: string;
  health?: SystemsHealthFilter;
  linked?: SystemsLinkedFilter;
}): string {
  const qs = new URLSearchParams();
  const q = (opts.q ?? '').trim();
  if (q) qs.set('q', q);
  if (opts.health && opts.health !== 'all') qs.set('health', opts.health);
  if (opts.linked && opts.linked !== 'all') qs.set('linked', opts.linked);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** Stable bulk/deep-link key for a plane row — registry id when known, else name. */
export function systemsPlaneKey(view: {
  planeId?: string | null;
  row: { name: string; planeId?: string | null };
}): string {
  const id = (view.planeId ?? view.row.planeId ?? '').trim();
  if (id) return id;
  return view.row.name;
}
import '../app/app.css';









































const CONNECTOR_IDS = new Set<ConnectorId>(CONNECTOR_CATALOG.map((entry) => entry.id));

function isConnectorId(value: string): value is ConnectorId {
  return CONNECTOR_IDS.has(value as ConnectorId);
}

function endpointOptionValue(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function draftAuth(id: ConnectorId, kind = connectorCatalogEntry(id).auth[0]!.kind): ConnectorAuth {
  return { kind } as ConnectorAuth;
}

function connectorDraft(id: ConnectorId, endpoint?: string, scopes?: string[]): ConnectorConfig {
  const entry = connectorCatalogEntry(id);
  return {
    id,
    enabled: true,
    endpoint: endpoint || entry.endpoint.default,
    auth: draftAuth(id),
    verifyTls: true,
    pollIntervalSec: entry.defaultPollIntervalSec,
    callBudget: entry.defaultCallBudget,
    datasets: [...entry.supportedDatasets],
    scopes: scopes ?? entry.scopeOptions
      .filter((scope) => scope.value.startsWith('read:'))
      .map((scope) => scope.value),
  } as ConnectorConfig;
}

function readableCapability(value: string): string {
  return value.replace(/^direct_/, '').replace(/^brokered_/, '').replaceAll('_', ' ');
}

type SuccessfulProbe = {
  connectorId: ConnectorId;
  version: number;
  secretFingerprint: string;
};

type ConnectorSubmission = {
  connector: ConnectorConfig;
  fingerprintSource: string;
};

function secretFieldName(id: ConnectorId, authKind: ConnectorAuthKind, key: string): string {
  return `connector-secret-${id}-${authKind}-${key}`;
}

/**
 * A passed probe retains a SHA-256 digest, never credentials or the request
 * body. Save can therefore reject a DOM-only secret edit without secrets
 * entering React state or a ref.
 */
async function fingerprintSecrets(source: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('secure browser cryptography is unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function Systems() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const { pollIntervalSec } = useSettings();

  const [data, setData] = useState<SystemsData | null>(null);
  const [liveState, setLiveState] = useState<SystemsState | null>(null);

  const [detailName, setDetailName] = useState<string | null>(null);
  const [retireOpen, setRetireOpen] = useState(false);
  const [retireBusy, setRetireBusy] = useState(false);
  const [tab, setTab] = useState<DetailTab>('summary');
  const [showDormant, setShowDormant] = useState(false);
  /* Roster triage (?q= / ?health= / ?linked=) — same slice Download server CSV sends. */
  const [rosterQ, setRosterQ] = useState(() => searchParams.get('q') ?? '');
  const [rosterHealth, setRosterHealth] = useState<SystemsHealthFilter>(() =>
    parseSystemsHealthFilter(searchParams.get('health')),
  );
  const [rosterLinked, setRosterLinked] = useState<SystemsLinkedFilter>(() =>
    parseSystemsLinkedFilter(searchParams.get('linked')),
  );
  /* Keyboard/checkbox multi-select raises Export selected / Copy plane ids /
   * Copy names / Copy selection link. Independent of drawer open (?plane=). */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /systems?ids=central\nmist (bulk Copy selection link). */
  const idsFilter = namesFilterForParam(searchParams.get('ids'));

  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<ConnectorConfig>(() => connectorDraft('central'));
  /** True when the user has selected "Custom URL…" in a region-picker dropdown. */
  const [endpointCustomMode, setEndpointCustomMode] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testedOk, setTestedOk] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    authenticated?: boolean;
    dataset?: string;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const credentialVersionRef = useRef(0);
  const connectorFormRef = useRef<HTMLFormElement | null>(null);
  const successfulTestRef = useRef<SuccessfulProbe | null>(null);
  const [secretInputEpoch, setSecretInputEpoch] = useState(0);
  // Set when a field change invalidates a PASSED test — surfaced as a warning
  // so a green-then-edited drawer never looks saved when it cannot be.
  const [retestNeeded, setRetestNeeded] = useState(false);

  const selectedEntry = connectorCatalogEntry(draft.id);
  const selectedAuth = selectedEntry.auth.find((option) => option.kind === draft.auth.kind)
    ?? selectedEntry.auth[0]!;
  const authRecord = draft.auth as unknown as Record<string, string | number | undefined>;
  const selectedEndpointOption = selectedEntry.endpoint.options?.find(
    (option) => endpointOptionValue(option.value) === draft.endpoint,
  );

  const refresh = async () => {
    const [d, s] = await Promise.all([getSystems(), getSystemsState()]);
    setData(d);
    setLiveState(s);
  };

  /* The header stamps LIVE · SYNCED hh:mm, so a NOC tab must not sit on a
     mount-time snapshot under it: poll on the settings cadence, the same
     pattern Overview.tsx runs. One fetch at a time — a slow response never
     stacks up behind the interval. One guard the other screens do not need:
     a refresh must never disturb credential entry or a connection test, so
     polling suspends while the connect drawer is open (mirrored into a ref
     after every commit so the interval callback cannot close over a stale
     addOpen). A save or retire still re-reads explicitly via refresh(). */
  const addOpenRef = useRef(addOpen);
  useEffect(() => {
    addOpenRef.current = addOpen;
  }, [addOpen]);
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = () => {
      if (inFlight || addOpenRef.current) return;
      inFlight = true;
      void Promise.all([getSystems(), getSystemsState()])
        .then(([d, s]) => {
          if (live) {
            setData(d);
            setLiveState(s);
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

  /* Deep link: /systems?plane=<registryId> (a plane drawer's "open in
     Systems"). The drawer opens during render — an effect would commit one
     frame of the plane-less screen first — and the param strip stays an
     effect: navigation is router state, not this screen's. */
  const requestedPlane = searchParams.get('plane');
  const [handledPlaneLink, setHandledPlaneLink] = useState<string | null>(null);
  /* The strip turns ?plane=x into no param, and a later identical deep link
     must open the drawer again — so "handled" survives only while the param
     does. */
  const [prevRequestedPlane, setPrevRequestedPlane] = useState(requestedPlane);
  if (prevRequestedPlane !== requestedPlane) {
    setPrevRequestedPlane(requestedPlane);
    if (requestedPlane === null && handledPlaneLink !== null) setHandledPlaneLink(null);
  }
  /* Optional `?tab=summary|activity|config` opens that drawer tab. SSE still
     defaults to config (object inventory lives there); other planes default
     to summary unless the link names a known tab. */
  const requestedTabRaw = searchParams.get('tab');
  const requestedTab: DetailTab | null =
    requestedTabRaw === 'summary' || requestedTabRaw === 'activity' || requestedTabRaw === 'config'
      ? requestedTabRaw
      : null;
  if (data && requestedPlane && handledPlaneLink !== requestedPlane) {
    const row = data.systems.find(
      (system) =>
        system.planeId === requestedPlane ||
        PLANE_ID_BY_NAME[system.name] === requestedPlane,
    );
    if (row) {
      setHandledPlaneLink(requestedPlane);
      setDetailName(row.name);
      setTab(requestedTab ?? (requestedPlane === 'sse' ? 'config' : 'summary'));
    }
  }
  useEffect(() => {
    if (!requestedPlane || handledPlaneLink !== requestedPlane) return;
    const next = new URLSearchParams(searchParams);
    next.delete('plane');
    next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [requestedPlane, handledPlaneLink, searchParams, setSearchParams]);

  /* Deep-link scroll: `?section=portal|identity|assistant|notifications|runtime-debug`
     (plus aliases / hash) land on the matching Systems panel once the page body is
     painted. Unknown section keys are ignored. */
  const systemsSection =
    parseSystemsSection(searchParams.get('section')) ??
    parseSystemsSection(
      typeof window !== 'undefined' && window.location.hash
        ? window.location.hash.replace(/^#/, '')
        : null,
    );
  useEffect(() => {
    if (!data || data.apiError || !systemsSection) return;
    const t = window.setTimeout(() => {
      const el =
        document.getElementById(systemsSectionDomId(systemsSection)) ??
        document.getElementById(systemsSection);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
    return () => window.clearTimeout(t);
  }, [data, systemsSection]);

  /* Keep roster triage filters shareable without clobbering section=/plane=/ids=. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const qTrim = rosterQ.trim();
    if (qTrim) next.set('q', qTrim);
    else next.delete('q');
    if (rosterHealth !== 'all') next.set('health', rosterHealth);
    else next.delete('health');
    if (rosterLinked !== 'all') next.set('linked', rosterLinked);
    else next.delete('linked');
    /* Selection deep-link ids= is URL-owned (Copy selection link) — preserve. */
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [rosterQ, rosterHealth, rosterLinked, searchParams, setSearchParams]);

  /* Re-seed when the address bar changes externally (shared link / back). */
  useEffect(() => {
    const qFrom = searchParams.get('q') ?? '';
    const hFrom = parseSystemsHealthFilter(searchParams.get('health'));
    const lFrom = parseSystemsLinkedFilter(searchParams.get('linked'));
    setRosterQ((cur) => (cur === qFrom ? cur : qFrom));
    setRosterHealth((cur) => (cur === hFrom ? cur : hFrom));
    setRosterLinked((cur) => (cur === lFrom ? cur : lFrom));
  }, [searchParams]);

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;
  if (liveState?.apiError) return <ApiErrorState message={liveState.apiError} />;

  // -- merged per-plane view ---------------------------------------------------
  // The server decides demo-vs-live per section: a demo payload is the
  // authored SYSTEMS rows and must render as authored. Overlaying the registry
  // on them stamps every row 'unlinked / never / 0' next to a fixture device
  // count on a stock demo install, which reads as a broken screen.
  const systemsLive = data.dataSource === 'live' || (data.blended?.includes('systems') ?? false);
  const views: PlaneView[] = data.systems.map((row) => {
    // Live rows carry the registry planeId — trust it over the name reverse-
    // lookup, which breaks the moment an operator renames a plane.
    const planeId = (row.planeId as SystemTypeKey | undefined) ?? PLANE_ID_BY_NAME[row.name] ?? null;
    const live = (systemsLive && planeId && liveState?.planes[planeId]) || null;
    return {
      row,
      planeId,
      live,
      stateLabel: live ? live.health : row.state,
      stateTone: live ? HEALTH_TONE[live.health] : row.tone,
      facts: mergedFacts(row, live),
    };
  });
  const linkedCount = views.filter((v) => v.live?.linked).length;
  // A live section knows which planes were never configured; an authored one
  // has no such thing, so every fixture row stays in the primary table.
  const rosterFilter = { q: rosterQ, health: rosterHealth, linked: rosterLinked };
  const rosterFilterActive =
    rosterQ.trim().length > 0 ||
    rosterHealth !== 'all' ||
    rosterLinked !== 'all' ||
    idsFilter !== null;
  const dormantViewsAll =
    systemsLive && liveState ? views.filter((v) => v.live && !v.live.linked) : [];
  const activeViewsAll = views.filter((v) => !dormantViewsAll.includes(v));
  const matchesIds = (v: PlaneView) => {
    if (idsFilter === null) return true;
    const key = systemsPlaneKey(v);
    return idsFilter.some((id) => id.toLowerCase() === key.toLowerCase());
  };
  const dormantViews = dormantViewsAll
    .filter((v) => systemsViewMatchesFilters(v, rosterFilter))
    .filter(matchesIds);
  const activeViews = activeViewsAll
    .filter((v) => systemsViewMatchesFilters(v, rosterFilter))
    .filter(matchesIds);
  const visibleViews = [...activeViews, ...dormantViews];
  const visibleKeySet = new Set(visibleViews.map(systemsPlaneKey));
  const prunedKeys = selectedKeys.filter((k) => visibleKeySet.has(k));
  if (prunedKeys.length !== selectedKeys.length) setSelectedKeys(prunedKeys);
  const togglePlaneSelect = (v: PlaneView) => {
    const key = systemsPlaneKey(v);
    setSelectedKeys((cur) =>
      cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
    );
  };
  const clearIdsFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('ids');
    setSearchParams(next, { replace: true });
  };
  /* Health chips count over q+linked (not health); Linked chips over q+health
   * (not linked) so each mix stays visible while a chip is active. */
  const healthUniverse = views.filter((v) =>
    systemsViewMatchesFilters(v, { q: rosterQ, health: 'all', linked: rosterLinked }),
  );
  const linkedUniverse = views.filter((v) =>
    systemsViewMatchesFilters(v, { q: rosterQ, health: rosterHealth, linked: 'all' }),
  );
  const SYSTEMS_HEALTH_CHIP_META: Array<{
    key: Exclude<SystemsHealthFilter, 'all'>;
    label: string;
    tone: 'success' | 'warning' | 'danger' | 'neutral';
  }> = [
    { key: 'healthy', label: 'Healthy', tone: 'success' },
    { key: 'warning', label: 'Warning', tone: 'warning' },
    { key: 'degraded', label: 'Degraded', tone: 'danger' },
    { key: 'unlinked', label: 'Unlinked', tone: 'neutral' },
  ];
  const healthChips = SYSTEMS_HEALTH_CHIP_META.map((m) => ({
    ...m,
    count: healthUniverse.filter((v) => {
      const h = String(v.stateLabel ?? v.row.state ?? '')
        .trim()
        .toLowerCase();
      return h === m.key;
    }).length,
  })).filter((c) => c.count > 0 || rosterHealth === c.key);
  const SYSTEMS_LINKED_CHIP_META: Array<{
    key: Exclude<SystemsLinkedFilter, 'all'>;
    label: string;
    tone: 'success' | 'neutral';
  }> = [
    { key: '1', label: 'Linked', tone: 'success' },
    { key: '0', label: 'Unlinked', tone: 'neutral' },
  ];
  const linkedChips = SYSTEMS_LINKED_CHIP_META.map((m) => ({
    ...m,
    count: linkedUniverse.filter((v) =>
      systemsViewMatchesFilters(v, { q: rosterQ, health: rosterHealth, linked: m.key }),
    ).length,
  })).filter((c) => c.count > 0 || rosterLinked === c.key);
  /* When triage filters leave only unlinked rows, expand the dormant block so
     the match is not hidden behind a collapsed "+ N not linked" control. */
  const showDormantEffective = showDormant || (rosterFilterActive && dormantViews.length > 0);
  const throttle = systemsLive ? throttleBanner(views) : null;
  /* Ahead of the throttle banner on purpose: being rate-limited means the
     inventory is behind, while a failing poll may mean there is none. When
     throttling is what is causing the failures, the registry's note says so
     and rides along in this banner's body. */
  const pollFailure = systemsLive ? pollFailureBanner(views) : null;

  const cur = data.systems.find((s) => s.name === detailName) ?? null;
  const curView = views.find((v) => v.row.name === detailName) ?? null;
  const curCalls = cur && curView ? callsFor(cur, curView.live) : [];
  // Same rule as the rows: the poller log belongs to a live section, the
  // authored log to a demo one — never the two spliced together.
  const history = historyRows(systemsLive ? (liveState?.history ?? null) : null, data.syncHistory);

  const openPlane = (v: PlaneView) => {
    setDetailName(v.row.name);
    setTab(v.row.planeId === 'sse' ? 'config' : 'summary');
  };

  // -- header / drawer actions --------------------------------------------------
  const syncAll = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await syncSystems();
      if (!result.ok) {
        toast(result.message, { tone: 'danger' });
        return;
      }
      await refresh();
      toast('sync complete', { description: result.message, tone: 'success' });
    } catch (err) {
      // Without this the spinner would run forever and the operator would
      // read "still syncing" when nothing is syncing.
      toast('sync failed', {
        description: err instanceof Error ? err.message : String(err),
        tone: 'danger',
      });
    } finally {
      setSyncing(false);
    }
  };

  const openConnect = (prefill?: {
    type: ConnectorId;
    endpoint?: string;
    scopes?: string[];
  }) => {
    credentialVersionRef.current += 1;
    successfulTestRef.current = null;
    // A new drawer session gets new DOM inputs even if it opens the same
    // product and auth kind as the last one.
    setSecretInputEpoch((epoch) => epoch + 1);
    const id = prefill?.type ?? 'central';
    const entry = connectorCatalogEntry(id);
    const endpoint = prefill?.endpoint || entry.endpoint.default;
    setDraft(connectorDraft(id, endpoint, prefill?.scopes));
    setEndpointCustomMode(Boolean(
      entry.endpoint.options && !entry.endpoint.options.some(
        (option) => endpointOptionValue(option.value) === endpoint,
      ),
    ));
    setTesting(false);
    setTestedOk(false);
    setTestResult(null);
    setRetestNeeded(false);
    setDetailName(null);
    setAddOpen(true);
  };

  const closeConnect = () => {
    credentialVersionRef.current += 1;
    successfulTestRef.current = null;
    setSecretInputEpoch((epoch) => epoch + 1);
    setTesting(false);
    setTestedOk(false);
    setTestResult(null);
    setRetestNeeded(false);
    setAddOpen(false);
  };

  /**
   * Hand off to the plane's own console. The button is disabled without a
   * URL, so this is only reachable with one — but a browser that refuses the
   * popup returns null, and that is a hand-off that did NOT happen: say so
   * and show the URL rather than let the click look successful.
   */
  const openConsole = (row: SystemRow) => {
    if (!row.consoleUrl) return;
    const opened = window.open(row.consoleUrl, '_blank', 'noopener');
    if (!opened) {
      toast(`Could not open the ${row.name} console`, {
        description: `The browser blocked the new tab — open ${row.consoleUrl} directly.`,
        tone: 'warning',
      });
    }
  };

  const requestRetire = () => {
    if (!cur || !curView?.planeId) {
      toast('cannot retire — this plane is not in the registry', { tone: 'danger' });
      return;
    }
    setRetireOpen(true);
  };

  const retire = async () => {
    if (!cur || !curView?.planeId) {
      toast('cannot retire — this plane is not in the registry', { tone: 'danger' });
      return;
    }
    setRetireBusy(true);
    try {
      const res = await retireSystem(curView.planeId);
      if (!res.ok) {
        toast(res.message, { tone: 'danger' });
        return;
      }
      toast(`${cur.name} retired`, { description: res.message, tone: 'success' });
      setDetailName(null);
      await refresh();
    } finally {
      setRetireBusy(false);
    }
  };

  // -- connect form ---------------------------------------------------------------
  const invalidate = () => {
    credentialVersionRef.current += 1;
    if (testedOk || successfulTestRef.current) setRetestNeeded(true);
    successfulTestRef.current = null;
    setTestedOk(false);
    setTestResult(null);
  };

  /**
   * Secret inputs are intentionally uncontrolled. This creates the typed
   * request only at submit time; the request remains a local value through
   * the fetch and is never copied into state, refs, or test-result UI.
   */
  const connectorSubmission = (): ConnectorSubmission => {
    const auth = { ...draft.auth } as Record<string, string | number | undefined>;
    const secretValues = selectedAuth.fields
      .filter((field) => field.secret)
      .map((field) => {
        const input = connectorFormRef.current?.querySelector<HTMLInputElement>(
          `input[name="${secretFieldName(draft.id, selectedAuth.kind, field.key)}"]`,
        );
        const value = input?.value ?? '';
        if (!value && !field.required) delete auth[field.key];
        else auth[field.key] = value;
        return [field.key, value];
      });
    return {
      connector: { ...draft, auth: auth as unknown as ConnectorAuth } as ConnectorConfig,
      fingerprintSource: JSON.stringify({
        connectorId: draft.id,
        authKind: selectedAuth.kind,
        secretValues,
      }),
    };
  };

  const secureFingerprint = async (submission: ConnectorSubmission): Promise<string | null> => {
    try {
      return await fingerprintSecrets(submission.fingerprintSource);
    } catch {
      toast('Secure credential check unavailable', {
        description: 'This browser cannot safely bind the successful test to the current credentials.',
        tone: 'danger',
      });
      return null;
    }
  };

  const testConnection = async () => {
    if (testing) return;
    const requestVersion = credentialVersionRef.current;
    const request = connectorSubmission();
    const requestFingerprint = await secureFingerprint(request);
    if (!requestFingerprint || requestVersion !== credentialVersionRef.current) return;
    setTesting(true);
    setTestResult(null);
    setTestedOk(false);
    setRetestNeeded(false);
    successfulTestRef.current = null;
    const res = await testSystem(request.connector.id, request.connector as unknown as Record<string, unknown>);
    setTesting(false);
    const current = connectorSubmission();
    const currentFingerprint = await secureFingerprint(current);
    if (
      requestVersion !== credentialVersionRef.current ||
      request.connector.id !== current.connector.id ||
      requestFingerprint !== currentFingerprint
    ) {
      setTestResult(null);
      setTestedOk(false);
      successfulTestRef.current = null;
      if (res.ok) setRetestNeeded(true);
      return;
    }
    setTestResult(res);
    setTestedOk(res.ok);
    successfulTestRef.current = res.ok
      ? { connectorId: request.connector.id, version: requestVersion, secretFingerprint: requestFingerprint }
      : null;
  };

  const saveAndIndex = async () => {
    const tested = successfulTestRef.current;
    const current = connectorSubmission();
    const currentFingerprint = await secureFingerprint(current);
    if (
      !tested ||
      !testedOk ||
      !currentFingerprint ||
      tested.connectorId !== current.connector.id ||
      tested.version !== credentialVersionRef.current ||
      tested.secretFingerprint !== currentFingerprint
    ) {
      successfulTestRef.current = null;
      setTestedOk(false);
      setTestResult(null);
      setRetestNeeded(true);
      toast('Re-test required', {
        description: 'The current credentials are different from the successful test.',
        tone: 'warning',
      });
      return;
    }
    const res = await saveSystemCredentials(
      current.connector.id,
      current.connector as unknown as Record<string, unknown>,
    );
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    // The title follows the poll the save actually ran. Announcing success
    // over a plane that answered 401 is the failure this screen exists to
    // surface, dressed as the opposite.
    // Only 'error' earns the caveat. A poll still running is not a failure, and
    // the description already says so — a caveat over a save that worked would
    // be its own small dishonesty.
    toast(res.indexed === 'error' ? 'Saved — but the plane did not answer' : 'Saved', {
      description: res.message,
      tone: res.indexed === 'error' ? 'warning' : 'success',
    });
    closeConnect();
    await refresh();
  };

  const updateDraft = (next: ConnectorConfig) => {
    setDraft(next);
    invalidate();
  };

  const updateAuthField = (field: ConnectorAuthField, value: string) => {
    // Secrets must never take this controlled-state path.
    if (field.secret) return;
    const nextAuth = { ...draft.auth } as Record<string, string | number | undefined>;
    if (field.type === 'number') {
      if (!value.trim()) delete nextAuth[field.key];
      else nextAuth[field.key] = Number(value);
    } else if (!value && !field.required) {
      delete nextAuth[field.key];
    } else {
      nextAuth[field.key] = value;
    }
    updateDraft({ ...draft, auth: nextAuth as unknown as ConnectorAuth } as ConnectorConfig);
  };

  const togglePolicyValue = (key: 'datasets' | 'scopes', value: string, checked: boolean) => {
    const current = draft[key] as string[];
    updateDraft({
      ...draft,
      [key]: checked ? [...current, value] : current.filter((item) => item !== value),
    } as ConnectorConfig);
  };

  return (
    <>
    <div className="nt-systems nt-recon-reveal nt-systems-shell nt-section-panel">
      <ScreenHeader
        overline="Platforms / Connected systems"
        title="Connected systems"
        subtitle="Live connector state and configuration."
        actions={
          <>
            {/* Design rule 1: the screen says which source answered and how
                fresh it is. Same vocabulary as SiteDetail so the portal does
                not invent a third phrasing for one state. */}
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · Copper NOC
            </span>
            <span
              className="nt-mono-label"
            >
              {systemsLive
                ? `LIVE · SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : 'NEVER'}`
                : 'DEMO FIXTURE'}
            </span>
            {/* LIVE badge on pure live and systems blend alike — mono stamp alone is easy to miss (Loop 169). */}
            {systemsLive ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(window.location.href).then(
                  () => toast('View link copied', { tone: 'success' }),
                  () => toast('Could not copy link', { tone: 'danger' }),
                );
              }}
            >
              Copy view link
            </Button>
            {systemsLive ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Download systems roster CSV"
                onClick={() => {
                  void (async () => {
                    const suffix = buildSystemsExportQuery({
                      q: rosterQ,
                      health: rosterHealth,
                      linked: rosterLinked,
                    });
                    const res = await downloadApiCsv(
                      `/api/systems/export${suffix}`,
                      'systems-roster.csv',
                    );
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description: suffix
                          ? `systems-roster.csv — filtered roster (${suffix.slice(1)}; no credentials).`
                          : 'systems-roster.csv — plane name/health/scope/sync/counts only (no credentials).',
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
            <Button variant="ghost" size="sm" onClick={() => void syncAll()} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync all'}
            </Button>
            <Button variant="primary" size="sm" onClick={() => openConnect()}>
              Connect a system
            </Button>
          </>
        }
      />
      <div className="nt-plane-theater" role="note">NightDesk · systems spine · identity · brokers · health</div>

      <VisualReferencePanel target={{ kind: 'estate', id: 'systems' }} />
      <ConfigRecommendationsPanel title="Connector health recommendations" limit={6} />

      {/* Authored on the demo section; derived from the registry's own 429s on
          a live one — never an incident on a plane that was never configured. */}
      {!systemsLive ? (
        <Alert tone="danger" title="Central Classic is throttling us" dismissible>
          <span className="nt-body-sm">
            Two API clients share one token quota on the Classic tenant, so every third poll returns
            429 and inventory falls behind. Re-key the portal client, or retire the legacy scripts
            still using it.
          </span>
        </Alert>
      ) : pollFailure ? (
        <Alert tone="danger" title={pollFailure.title} dismissible>
          <span className="nt-body-sm">{pollFailure.body}</span>
        </Alert>
      ) : throttle ? (
        <Alert tone="danger" title={throttle.title} dismissible>
          <span className="nt-body-sm">{throttle.body}</span>
        </Alert>
      ) : null}

      {liveState === null ? (
        <div
          className="nt-hint-muted"
        >
          backend offline — fixture state
        </div>
      ) : null}

      {/* ---------------- plane rows ---------------- */}
      <div className="nt-system-list">
        <SectionHeader
          label="Planes"
          meta={
            /* The meta line counts what is on screen. On a live section that
               is the genuinely linked planes; on an authored one it is the
               rows themselves — never a literal that goes stale the moment a
               fixture plane is added (the authored set is eight, not seven). */
            rosterFilterActive
              ? `${activeViews.length + dormantViews.length} of ${views.length} match`
              : systemsLive && liveState
                ? `${linkedCount} LINKED · SELECT ONE FOR DETAIL`
                : `${data.systems.length} LINKED · SELECT ONE FOR DETAIL`
          }
        />
        <div className="nt-filter-bar nt-sticky-filters nt-gap-8">
          <div className="nt-filter-field nt-min-w-200">
            <Input
              size="sm"
              mono
              placeholder="Name, plane id, scope…"
              value={rosterQ}
              onChange={(e) => setRosterQ(e.target.value)}
              aria-label="Filter systems roster"
            />
          </div>
          <div className="nt-filter-field nt-filter-field--md">
            <Select
              options={[...SYSTEMS_HEALTH_FILTERS]}
              value={rosterHealth}
              onValueChange={(v) => setRosterHealth(parseSystemsHealthFilter(v))}
              size="sm"
              aria-label="Health"
            />
          </div>
          <div className="nt-filter-field nt-filter-field--md">
            <Select
              options={[...SYSTEMS_LINKED_FILTERS]}
              value={rosterLinked}
              onValueChange={(v) => setRosterLinked(parseSystemsLinkedFilter(v))}
              size="sm"
              aria-label="Linked"
            />
          </div>
        </div>
        {healthChips.length > 0 ? (
          <div className="nt-chip-row" role="group" aria-label="Systems health">
            <span className="nt-chip-row__label">Health</span>
            {healthChips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setRosterHealth(rosterHealth === c.key ? 'all' : c.key)}
                className={rosterHealth === c.key ? 'nt-chip nt-chip--active' : 'nt-chip'}
                aria-pressed={rosterHealth === c.key}
              >
                <Badge tone={c.tone}>{c.label}</Badge>
                <span className="nt-chip__count">{c.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        {linkedChips.length > 0 ? (
          <div className="nt-chip-row" role="group" aria-label="Systems linked">
            <span className="nt-chip-row__label">Linked</span>
            {linkedChips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setRosterLinked(rosterLinked === c.key ? 'all' : c.key)}
                className={
                  rosterLinked === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
                }
                aria-pressed={rosterLinked === c.key}
                data-linked={c.key}
              >
                <Badge tone={c.tone}>{c.label}</Badge>
                <span className="nt-chip__count">{c.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        {idsFilter !== null ? (
          <div className="nt-chip-row" role="status">
            <button
              type="button"
              className="nt-chip nt-chip--active"
              onClick={clearIdsFilter}
              aria-label="Clear plane selection link filter"
              title={idsFilter.join(', ')}
            >
              {(() => {
                const present = visibleViews.filter((v) =>
                  idsFilter.some(
                    (id) => id.toLowerCase() === systemsPlaneKey(v).toLowerCase(),
                  ),
                ).length;
                return present === idsFilter.length
                  ? `${idsFilter.length} selected plane${idsFilter.length === 1 ? '' : 's'}`
                  : `${present} of ${idsFilter.length} selected planes present`;
              })()}
              {' — clear'}
            </button>
          </div>
        ) : null}
        <div className="nt-plane-table" role="table" aria-label="Connected planes">
          <div className="nt-plane-select-row nt-plane-select-row--head" role="row">
            <span role="columnheader" className="nt-plane-row__check" aria-label="Select" />
            <div className="nt-plane-row nt-plane-row--head" role="presentation">
              <span role="columnheader">System</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Last sync</span>
              <span role="columnheader" className="nt-plane-row--num">
                Inventory
              </span>
              <span role="columnheader" className="nt-plane-row--num">
                Calls
              </span>
              <span role="columnheader">Auth</span>
              <span role="columnheader">Scope</span>
              <span role="columnheader" aria-label="Open detail" />
            </div>
          </div>
          {activeViews.map((v) => {
            const key = systemsPlaneKey(v);
            const marked = selectedKeys.includes(key);
            return (
              <div key={v.row.name} className="nt-plane-select-row">
                <span className="nt-plane-row__check">
                  <Checkbox
                    aria-label={`Select plane ${v.row.name}`}
                    checked={marked}
                    onChange={() => togglePlaneSelect(v)}
                  />
                </span>
                <PlaneRow view={v} onOpen={openPlane} />
              </div>
            );
          })}
          {activeViews.length === 0 && dormantViews.length === 0 ? (
            <div className="nt-hint-muted nt-p-12" role="status">
              <div>
                {idsFilter !== null
                  ? 'No planes match this selection. Clear the selection filter to restore the roster under the current q / health / linked filters.'
                  : 'Nothing matches this roster filter. Clear q / health / linked to see every plane.'}
              </div>
              {idsFilter !== null ? (
                <div className="nt-mt-8">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSelectedKeys([]);
                      const next = new URLSearchParams(searchParams);
                      next.delete('ids');
                      if (next.toString() !== searchParams.toString()) {
                        setSearchParams(next, { replace: true });
                      }
                    }}
                  >
                    Clear selection filter
                  </Button>
                </div>
              ) : rosterFilterActive ? (
                <div className="nt-mt-8">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRosterQ('');
                      setRosterHealth('all');
                      setRosterLinked('all');
                      setSelectedKeys([]);
                      /* Drop URL-owned triage params in the same turn so the
                         address-bar re-seed cannot restore a stale q/health/linked. */
                      const next = new URLSearchParams(searchParams);
                      next.delete('q');
                      next.delete('health');
                      next.delete('linked');
                      if (next.toString() !== searchParams.toString()) {
                        setSearchParams(next, { replace: true });
                      }
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {/* A plane that was never configured has nothing to report, and eight
            of them repeating "never / — / no credentials stored" buried the two
            that do. They collapse into one line that opens on demand. */}
        {dormantViews.length > 0 ? (
          <div className="nt-plane-dormant">
            <button
              type="button"
              className="nt-plane-dormant__toggle"
              aria-expanded={showDormantEffective}
              onClick={() => setShowDormant((v) => !v)}
            >
              <span aria-hidden="true">{showDormantEffective ? '−' : '+'}</span>
              {`${countOf(dormantViews.length, 'system')} not linked`}
              <small>no credentials stored — nothing is polled</small>
            </button>
            {showDormantEffective ? (
              <div className="nt-plane-table" role="table" aria-label="Systems that are not linked">
                {dormantViews.map((v) => {
                  const key = systemsPlaneKey(v);
                  const marked = selectedKeys.includes(key);
                  return (
                    <div key={v.row.name} className="nt-plane-select-row">
                      <span className="nt-plane-row__check">
                        <Checkbox
                          aria-label={`Select plane ${v.row.name}`}
                          checked={marked}
                          onChange={() => togglePlaneSelect(v)}
                        />
                      </span>
                      <PlaneRow view={v} onOpen={openPlane} />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        {selectedKeys.length > 0 ? (
          <div
            className="nt-configure-bulk-bar nt-bulk-glass"
            role="region"
            aria-label="Plane selection actions"
          >
            <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
            <span className="nt-configure-bulk-bar__hint">
              export, copy plane ids/names, or share a selection link for only the planes you marked —
              drawer open stays independent
            </span>
            <span className="nt-configure-bulk-bar__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const selected = new Set(selectedKeys);
                  const picked = visibleViews.filter((v) => selected.has(systemsPlaneKey(v)));
                  if (picked.length === 0) {
                    toast('No selected planes still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const n = exportTableCsv(
                    'systems-planes-selected.csv',
                    ['name', 'planeId', 'kind', 'health', 'scope', 'linked', 'lastSync', 'inventory', 'calls'],
                    picked.map((v) => {
                      const inv = countFact(v.facts);
                      return [
                        v.row.name,
                        systemsPlaneKey(v),
                        v.row.kind,
                        v.stateLabel,
                        v.row.scope,
                        v.live ? (v.live.linked ? 'yes' : 'no') : '',
                        factValue(v.facts, 'Last sync') ?? '',
                        inv ? `${inv.value} ${inv.unit}`.trim() : '',
                        factValue(v.facts, 'Calls today') ?? '',
                      ];
                    }),
                  );
                  toast(`Exported ${countOf(n, 'selected plane')}`, {
                    description: 'systems-planes-selected.csv — roster fields only (no credentials).',
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
                    const picked = visibleViews.filter((v) => selected.has(systemsPlaneKey(v)));
                    if (picked.length === 0) {
                      toast('No selected planes still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const ids = [...new Set(picked.map(systemsPlaneKey).filter(Boolean))];
                    if (ids.length === 0) {
                      toast('No plane ids on the selection', {
                        description: 'Use Copy names or export CSV instead.',
                        tone: 'info',
                      });
                      return;
                    }
                    const text = ids.join('\n');
                    try {
                      await navigator.clipboard.writeText(text);
                      toast(`Copied ${countOf(ids.length, 'plane id')}`, {
                        description: 'newline-joined · paste into a ticket or change window',
                        tone: 'success',
                      });
                    } catch {
                      toast('Could not copy plane ids', { description: text, tone: 'warning' });
                    }
                  })();
                }}
              >
                Copy plane ids
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const selected = new Set(selectedKeys);
                    const picked = visibleViews.filter((v) => selected.has(systemsPlaneKey(v)));
                    if (picked.length === 0) {
                      toast('No selected planes still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const names = [
                      ...new Set(
                        picked
                          .map((v) => (v.row.name ?? '').trim())
                          .filter((name) => name && name !== '—'),
                      ),
                    ];
                    if (names.length === 0) {
                      toast('No names on the selected planes', {
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
                    const picked = visibleViews.filter((v) => selected.has(systemsPlaneKey(v)));
                    if (picked.length === 0) {
                      toast('No selected planes still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const next = new URLSearchParams(searchParams);
                    next.set('ids', picked.map(systemsPlaneKey).join('\n'));
                    const qs = next.toString();
                    const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                    try {
                      await navigator.clipboard.writeText(url);
                      toast('Selection link copied', {
                        description: `${picked.length} plane${picked.length === 1 ? '' : 's'} · ids=`,
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

      <Divider variant="flair" />

      {/* ---------------- sync history + permissions ---------------- */}
      <div
        className="nt-systems__lower-grid"
      >
        <div className="nt-stack nt-gap-2">
          <SectionHeader label="Sync history" meta="LAST 2 HOURS" />
          {history.map((h, i) => (
            <div key={`${h.time}-${h.system}-${i}`} className="nt-sync-row">
              <span className="nt-sync-row__time">{hhmm(h.time)}</span>
              <span className="nt-sync-row__plane">{h.system}</span>
              <span className="nt-sync-row__what">{h.what}</span>
              <Badge tone={h.tone}>{h.result}</Badge>
            </div>
          ))}
          {history.length === 0 ? (
            <div className="nt-sync-row__empty">no sync events recorded yet</div>
          ) : null}
        </div>

        <div className="nt-stack nt-gap-12">
          <SectionHeader label="Permissions model" />
          <div className="nt-body-sm nt-lh-16">
            The portal never holds standing write access. Read scopes are permanent; write is
            brokered per change, expires in fifteen minutes, and is stamped with the ticket that
            authorised it.
          </div>
          {data.permissions.map((p) => (
            <div key={p.mode} className="nt-perm-row">
              <Badge tone={p.tone}>{p.mode}</Badge>
              <span className="nt-body-sec nt-flex-1">
                {p.what}
              </span>
            </div>
          ))}
        </div>
      </div>

      <Divider variant="flair" />

      {/* ---------------- portal (this app) ---------------- */}
      <PortalSection />

      <Divider variant="flair" />

      {/* ---------------- identity provider (who may use this) ---------------- */}
      <IdentityProviderSection />

      <Divider variant="flair" />

      {/* ---------------- assistant (chat) ---------------- */}
      <AssistantSection />

      <Divider variant="flair" />

      {/* ---------------- notifications (outbound alert webhooks) ---------------- */}
      <NotificationsSection />

      <Divider variant="flair" />

      {/* ---------------- runtime debug (no secrets) ---------------- */}
      <RuntimeDebugSection />

      {/* ---------------- plane detail drawer ---------------- */}
      <Drawer
        open={cur !== null}
        onOpenChange={(v) => {
          if (!v) setDetailName(null);
        }}
        width="lg"
        title={cur?.name ?? ''}
        description={cur?.kind ?? ''}
      >
        {cur && curView ? (
          <div className="nt-stack nt-gap-18">
            <div className="nt-chip-row">
              <Badge tone={curView.stateTone} dot>
                {curView.stateLabel}
              </Badge>
              {curView.live?.stale ? (
                <span title={staleTitle(curView.live)}>
                  <Badge tone="warning">unverified</Badge>
                </span>
              ) : null}
              <Badge tone={cur.scopeTone}>{cur.scope}</Badge>
              <span
                className="nt-hint-muted"
              >
                {curView.live?.note ?? cur.scopeNote}
              </span>
              {/* Why the plane is behind, when the registry knows: failed
                  polls record no error on the row itself, so without this the
                  drawer shows a stale plane with nothing to explain it. */}
              {curView.live && retryNote(curView.live) ? (
                <span
                  className="nt-hint-muted nt-warning-text"
                >
                  {retryNote(curView.live)}
                </span>
              ) : null}
            </div>

            <SegmentedControl options={TAB_OPTIONS} value={tab} onValueChange={(v) => setTab(v as DetailTab)} />

            {tab === 'summary' ? (
              <div className="nt-stack nt-gap-18">
                <div className="nt-row nt-gap-8">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const planeId = curView.planeId ?? '';
                      const safeName = (cur.name || planeId || 'plane')
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, '');
                      const rows: Array<Array<unknown>> = [
                        ['field', 'value'],
                        ['plane', cur.name],
                        ['planeId', planeId],
                        ['kind', cur.kind],
                        ['health', curView.stateLabel],
                        ['healthTone', curView.stateTone],
                        ['unverified', curView.live?.stale ? 'yes' : 'no'],
                        ['scope', cur.scope],
                        ['note', curView.live?.note ?? cur.scopeNote],
                        ['retry', curView.live ? retryNote(curView.live) ?? '' : ''],
                        ['lastSync', curView.live?.lastSync ?? ''],
                        ['consecutiveFailures', curView.live?.consecutiveFailures ?? ''],
                        ['callsToday', curView.live?.callsToday ?? ''],
                        ['deviceCount', curView.live?.deviceCount ?? ''],
                      ];
                      for (const f of curView.facts) {
                        rows.push([`fact:${f.k}`, f.v]);
                      }
                      for (const s of cur.sites) {
                        rows.push([`site:${s.name}`, s.detail]);
                      }
                      for (const l of cur.live) {
                        rows.push([`live:${l.label}`, l.value]);
                      }
                      /* Drop the header row we used as a template — exportTableCsv
                         takes headers separately. */
                      const body = rows.slice(1);
                      const n = exportTableCsv(
                        `plane-health-${safeName || 'summary'}.csv`,
                        ['field', 'value'],
                        body,
                      );
                      toast(`Exported health summary (${n} rows)`, {
                        description: `${cur.name} — facts, sites, and live counts only. No credentials.`,
                        tone: 'success',
                      });
                    }}
                  >
                    Export health summary
                  </Button>
                </div>
                <div className="nt-fact-grid nt-fact-grid--dense">
                  {curView.facts.map((f) => (
                    <div key={f.k} className="nt-metric-tile nt-metric-tile--bordered">
                      <span className="nt-fact-row__k nt-flex-none">{f.k}</span>
                      <span className="nt-fact-row__v">{f.v}</span>
                    </div>
                  ))}
                </div>

                <div className="nt-stack nt-gap-2">
                  <SectionHeader label="Sites on this plane" />
                  {cur.sites.map((x) => {
                    const siteId = x.siteId;
                    return (
                      <div
                        key={x.name}
                        className="nt-row-center nt-gap-10 nt-rule-row-md"
                      >
                        {/* A row that names a real site drills into it, closing
                            the drawer first (README navigation rules). The
                            'Workspace-wide' row carries siteId null and stays
                            plain text — there is no page to open. */}
                        {siteId ? (
                          <button
                            type="button"
                            onClick={() => {
                              setDetailName(null);
                              navigate(`/sites/${encodeURIComponent(siteId)}`);
                            }}
                            className="nt-sys-link"
                          >
                            {x.name}
                          </button>
                        ) : (
                          <span
                            className="nt-body-sm nt-flex-1 nt-text-primary"
                          >
                            {x.name}
                          </span>
                        )}
                        <span
                          className="nt-hint-muted"
                        >
                          {x.detail}
                        </span>
                      </div>
                    );
                  })}
                  {cur.sites.length === 0 ? (
                    <NothingReported label="no sites reported by this plane yet" />
                  ) : null}
                </div>

                <div className="nt-stack nt-gap-2">
                  <SectionHeader label="Live on this plane" />
                  {cur.live.map((l) => (
                    <div
                      key={l.label}
                      className="nt-row-center nt-gap-10 nt-rule-row-md"
                    >
                      <span
                        className="nt-mono-11 nt-sys-k"
                      >
                        {l.value}
                      </span>
                      <span className="nt-body-sec nt-flex-1">
                        {l.label}
                      </span>
                    </div>
                  ))}
                  {cur.live.length === 0 ? (
                    <NothingReported label="no sessions, devices or alerts sourced here yet" />
                  ) : null}
                  <div className="nt-chip-wrap nt-pt-12">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/devices?plane=${curView.planeId ?? ''}`)}
                    >
                      Devices →
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/clients?plane=${curView.planeId ?? ''}`)}
                    >
                      Clients →
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/auth-events?plane=${curView.planeId ?? ''}`)}
                    >
                      Auth events →
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {tab === 'activity' ? (
              <div className="nt-stack nt-gap-18">
                <div className="nt-stack nt-gap-2 nt-section-panel">
                  <SectionHeader label="API calls" meta="LAST 20 MINUTES" />
                  {curCalls.length > 0 ? (
                    <div className="nt-log-stream" role="log" aria-label="API calls last 20 minutes">
                      {curCalls.map((c, i) => (
                        <div
                          key={`${c.time}-${i}`}
                          className="nt-log-stream__line nt-row-center nt-gap-10 nt-rule-pad-7"
                          data-tone={c.tone === 'danger' || c.tone === 'warning' ? c.tone : undefined}
                        >
                          <span className="nt-log-stream__ts nt-hint-muted nt-w-44">
                            {hhmm(c.time)}
                          </span>
                          <span className="nt-ellipsis nt-mono-11 nt-flex-1 nt-text-sec">
                            {c.path}
                          </span>
                          <span className="nt-hint-muted nt-w-56-right">
                            {c.ms}
                          </span>
                          <Badge tone={c.tone}>{c.code}</Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="nt-hint-muted nt-pad-7-0">
                      no calls recorded yet
                    </div>
                  )}
                </div>

                <div className="nt-stack nt-gap-2 nt-section-panel">
                  <SectionHeader label="Recent events" />
                  {cur.events.length > 0 ? (
                    <div className="nt-log-stream" role="log" aria-label="Recent plane events">
                      {cur.events.map((e, i) => (
                        <div
                          key={`${e.time}-${i}`}
                          className="nt-log-stream__line nt-row nt-gap-12 nt-rule-row"
                        >
                          <span className="nt-log-stream__ts nt-hint-muted nt-w-44">
                            {hhmm(e.time)}
                          </span>
                          <div className="nt-flex-1">
                            <div className="nt-body-sm nt-text-pri-12">
                              {e.what}
                            </div>
                            <div className="nt-hint-muted">
                              {e.who}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <NothingReported label="no brokered writes, token rotations or cluster changes recorded" />
                  )}
                </div>
              </div>
            ) : null}

            {tab === 'config' ? (
              <div className="nt-stack nt-gap-18">
                {curView?.planeId === 'sse' ? (
                  curView.live?.linked ? (
                    <SseInventoryPanel canWrite={curView.live?.capabilities?.directWrite === true} />
                  ) : (
                    <div className="nt-stack nt-gap-6">
                      <SectionHeader label="Object inventory" />
                      <NothingReported label="connect this plane with an Admin API token to browse its object inventory" />
                    </div>
                  )
                ) : null}
                {curView?.planeId === 'central' ? (
                  // Mounted unconditionally (unlike SSE above): the demo
                  // 'configure' section serves canned webhooks even with no
                  // linked plane, and a not-linked/Classic-gateway live plane
                  // is itself an honest state the envelope's own `error`
                  // reports — see CentralWebhooksPanel / centralWebhooks.ts.
                  <CentralWebhooksPanel />
                ) : null}
                {curView?.planeId === 'mist' ? (
                  // Same unconditional mount as Central's panel: demo serves
                  // the authored registration + audit fixtures, and a
                  // not-linked live plane is an honest state the section
                  // reports itself — see systems/MistSection.tsx.
                  <MistSection />
                ) : null}
                <div className="nt-stack nt-gap-2">
                  <SectionHeader label="What the portal pulls" />
                  {cur.pulls.map((p) => (
                    <div
                      key={p.what}
                      className="nt-row-center nt-gap-10 nt-rule-row-md"
                    >
                      <span className="nt-body-sm nt-flex-1 nt-text-primary">
                        {p.what}
                      </span>
                      <span
                        className="nt-hint-muted nt-w-96-right"
                      >
                        {p.every}
                      </span>
                      <Badge tone={p.tone}>{p.mode}</Badge>
                    </div>
                  ))}
                </div>

                <div className="nt-stack nt-gap-10">
                  <SectionHeader label="Credential & connection" />
                  <Code block>{cur.configText}</Code>
                </div>

                <div className="nt-stack nt-gap-10">
                  <SectionHeader label="Actions" />
                  <div className="nt-chip-wrap">
                    <Button variant="secondary" size="sm" onClick={() => void syncAll()}>
                      Sync now
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        curView.planeId && isConnectorId(curView.planeId)
                          ? openConnect({
                              type: curView.planeId,
                              endpoint: storedEndpoint(cur, curView.planeId),
                              scopes: storedScopes(cur, curView.planeId, curView.live),
                            })
                          : undefined
                      }
                      disabled={!curView.planeId || !isConnectorId(curView.planeId)}
                    >
                      Re-key credentials
                    </Button>
                    {/* The hand-off is real when the row carries a console
                        URL (SystemRow.consoleUrl). The local switch collector
                        deliberately carries none — it has no console — so the
                        control is DISABLED there rather than toasting about a
                        hand-off it cannot make or inventing a URL for it. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!cur.consoleUrl}
                      title={cur.consoleUrl ?? `${cur.name} has no console to open`}
                      onClick={() => openConsole(cur)}
                    >
                      Open console ↗
                    </Button>
                    <Button variant="danger" size="sm" onClick={requestRetire}>
                      Retire plane
                    </Button>
                  </div>
                  {!cur.consoleUrl ? (
                    <span
                      className="nt-hint-muted"
                    >
                      no console URL recorded for {cur.name} — nothing to hand off to
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      {/* ---------------- connect a system drawer ---------------- */}
      <Drawer
        open={addOpen}
        onOpenChange={(open) => {
          if (open) setAddOpen(true);
          else closeConnect();
        }}
        width="lg"
        className="nd-drawer--write-ritual nt-write-ritual"
        title={`Configure ${selectedEntry.label}`}
      >
        <form
          ref={connectorFormRef}
          onSubmit={(event) => event.preventDefault()}
          className="nt-stack nt-gap-14"
        >
          <div className="nt-write-ritual nt-write-ritual--banner" aria-hidden />
          <div className="nt-chip-wrap nt-chip-wrap--tight" aria-label="Declared capabilities">
            <Badge tone={selectedEntry.tone}>{selectedEntry.contributesClients ? 'client source' : 'inventory source'}</Badge>
            {selectedEntry.writeCapabilities.length > 0 ? selectedEntry.writeCapabilities.map((capability) => (
              <Badge key={capability} tone="accent">write · {readableCapability(capability)}</Badge>
            )) : <Badge tone="neutral">read only</Badge>}
            {draft.id === 'central' ? <Badge tone="info">AOS-10 derived</Badge> : null}
          </div>

          {testResult ? (
            <Alert
              tone={testResult.ok ? 'success' : 'danger'}
              title={testResult.ok
                ? `Authenticated probe: ${testResult.dataset ?? 'completed'}`
                : 'Connection failed'}
            >
              <span className="nt-body-sm">{testResult.message}</span>
            </Alert>
          ) : null}

          <FormField label="System type">
            <Select
              options={CONNECTOR_CATALOG.map((entry) => ({ value: entry.id, label: entry.label }))}
              value={draft.id}
              onValueChange={(v) => {
                if (!isConnectorId(v)) return;
                setDraft(connectorDraft(v));
                setEndpointCustomMode(false);
                invalidate();
              }}
            />
          </FormField>

          <FormField label={selectedEntry.endpoint.label}>
            {selectedEntry.endpoint.options ? (
              <Select
                value={endpointCustomMode ? '__custom__' : (selectedEndpointOption
                  ? endpointOptionValue(selectedEndpointOption.value)
                  : '__custom__')}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '__custom__') {
                    setEndpointCustomMode(true);
                  } else {
                    setEndpointCustomMode(false);
                    updateDraft({ ...draft, endpoint: v });
                  }
                }}
              >
                {selectedEntry.endpoint.options.map((o) => (
                  <option key={o.value} value={endpointOptionValue(o.value)}>
                    {o.label}
                  </option>
                ))}
                <option value="__custom__">Custom URL…</option>
              </Select>
            ) : (
              <Input
                mono
                placeholder={selectedEntry.endpoint.hint}
                value={draft.endpoint}
                onChange={(e) => {
                  updateDraft({ ...draft, endpoint: e.target.value });
                }}
              />
            )}
          </FormField>

          {selectedEntry.endpoint.options && endpointCustomMode ? (
            <FormField label="Custom endpoint">
              <Input
                mono
                placeholder={selectedEntry.endpoint.hint}
                value={draft.endpoint}
                onChange={(e) => {
                  updateDraft({ ...draft, endpoint: e.target.value });
                }}
              />
            </FormField>
          ) : null}

          {selectedEntry.auth.length > 1 ? (
            <FormField label="Authentication">
              <Select
                options={selectedEntry.auth.map((option) => ({ value: option.kind, label: option.label }))}
                value={selectedAuth.kind}
                onValueChange={(value) => {
                  const kind = value as ConnectorAuthKind;
                  if (!selectedEntry.auth.some((option) => option.kind === kind)) return;
                  updateDraft({ ...draft, auth: draftAuth(draft.id, kind) } as ConnectorConfig);
                }}
              />
            </FormField>
          ) : null}

          <div className="nt-form-grid nt-gap-12">
            {selectedAuth.fields.map((field) => (
              <FormField key={`${secretInputEpoch}-${draft.id}-${selectedAuth.kind}-${field.key}`} label={field.label}>
                {field.secret ? (
                  <Input
                    mono
                    name={secretFieldName(draft.id, selectedAuth.kind, field.key)}
                    type="password"
                    placeholder="Stored secret"
                    onChange={invalidate}
                  />
                ) : (
                  <Input
                    mono
                    type={field.type === 'number' ? 'number' : undefined}
                    placeholder={field.required ? field.key : 'Optional'}
                    value={authRecord[field.key] ?? ''}
                    onChange={(e) => updateAuthField(field, e.target.value)}
                  />
                )}
              </FormField>
            ))}
          </div>

          <details>
            <summary className="nt-text-sec nt-fs-125 nt-cursor-pointer">
              Advanced policy
            </summary>
            <div className="nt-stack-col nt-gap-10 nt-pt-10">
              <Checkbox
                label="Verify TLS certificate"
                checked={draft.verifyTls}
                onChange={(e) => updateDraft({ ...draft, verifyTls: e.target.checked })}
              />
              {!draft.verifyTls ? <Alert tone="warning" title="TLS verification disabled" /> : null}
              <div className="nt-form-grid nt-gap-12">
                <FormField label="Poll cadence (seconds)">
                  <Input
                    mono
                    type="number"
                    value={draft.pollIntervalSec}
                    onChange={(e) => updateDraft({ ...draft, pollIntervalSec: Number(e.target.value) || 5 })}
                  />
                </FormField>
                <FormField label="Daily call budget">
                  <Input
                    mono
                    type="number"
                    placeholder="Provider default"
                    value={draft.callBudget ?? ''}
                    onChange={(e) => updateDraft({
                      ...draft,
                      callBudget: e.target.value.trim() ? Number(e.target.value) : null,
                    })}
                  />
                </FormField>
              </div>
              <div>
                <SectionHeader label="Datasets" />
                {selectedEntry.supportedDatasets.map((dataset) => (
                  <Checkbox
                    key={dataset}
                    label={dataset}
                    checked={draft.datasets.includes(dataset)}
                    onChange={(e) => togglePolicyValue('datasets', dataset, e.target.checked)}
                  />
                ))}
              </div>
              <div>
                <SectionHeader label="Scopes" />
                {selectedEntry.scopeOptions.map((scope) => (
                  <Checkbox
                    key={scope.value}
                    label={scope.label}
                    checked={draft.scopes.includes(scope.value)}
                    onChange={(e) => togglePolicyValue('scopes', scope.value, e.target.checked)}
                  />
                ))}
              </div>
            </div>
          </details>

          {retestNeeded && !testResult ? (
            <Alert tone="warning" title="Re-test required">
              <span className="nt-body-sm">Policy or credentials changed after the authenticated probe.</span>
            </Alert>
          ) : null}

          <div className="nt-row nt-gap-8">
            <Button
              variant="secondary"
              size="md"
              disabled={testing}
              onClick={() => void testConnection()}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={!testedOk}
              onClick={() => void saveAndIndex()}
            >
              Save and index
            </Button>
            <Button variant="ghost" size="md" onClick={closeConnect}>
              Cancel
            </Button>
          </div>
        </form>
      </Drawer>
    </div>
      <ConfirmDialog
        open={retireOpen}
        onOpenChange={setRetireOpen}
        title={cur ? `Retire ${cur.name}?` : 'Retire plane?'}
        description="Stored credentials are cleared and the plane becomes unlinked. This does not delete devices on the plane itself."
        confirmLabel="Retire plane"
        tone="danger"
        busy={retireBusy}
        onConfirm={retire}
      />
    </>
  );
}
