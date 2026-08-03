/**
 * web/src/screens/Systems.tsx — connected systems (the live one).
 * High-fidelity port of design/NtSystems.dc.html, with the descriptors from
 * getSystems() MERGED with live per-plane registry state from
 * getSystemsState() (GET /api/systems/state) — but only when the systems
 * section is actually live-sourced (dataSource 'live', or blended): a demo
 * payload is authored data and renders as authored, never stamped with the
 * empty registry ("unlinked / never / 0" beside a fixture device count).
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
 * (DEMO FIXTURE vs LIVE · SYNCED hh:mm) and the Planes meta counts what is
 * actually on screen, never a literal. The stamp is kept honest by polling on
 * the settings cadence (the Overview pattern, one fetch at a time) — suspended
 * while the connect drawer is open, because a refresh must never disturb
 * in-flight credential entry or a connection test. A drawer site row that names a real
 * site drills into it (closing the drawer first).
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
  Divider,
  Drawer,
  FormField,
  Input,
  SectionHeader,
  SegmentedControl,
  Select,
  Spinner,
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
import { ApiErrorState } from './ApiErrorState';
import { useSettings } from '../app/SettingsContext';
import { SseInventoryPanel } from './SseInventoryPanel';
import { CentralWebhooksPanel } from './CentralWebhooksPanel';
import { MistSection } from './systems/MistSection';
import { AssistantSection } from './systems/AssistantSection';
import { IdentityProviderSection } from './systems/IdentityProviderSection';
import { NotificationsSection } from './systems/NotificationsSection';
import {
  NothingReported,
  PlaneRow,
  callsFor,
  historyRows,
  throttleBanner,
  pollFailureBanner,
} from './systems/PlaneRow';
import { PortalSection } from './systems/PortalSection';
import {
  DetailTab,
  HEALTH_TONE,
  PLANE_ID_BY_NAME,
  PlaneView,
  TAB_OPTIONS,
  mergedFacts,
  retryNote,
  staleTitle,
  storedEndpoint,
  storedScopes,
} from './systems/facts';
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
  const [tab, setTab] = useState<DetailTab>('summary');
  const [showDormant, setShowDormant] = useState(false);

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
  if (data && requestedPlane && handledPlaneLink !== requestedPlane) {
    const row = data.systems.find(
      (system) =>
        system.planeId === requestedPlane ||
        PLANE_ID_BY_NAME[system.name] === requestedPlane,
    );
    if (row) {
      setHandledPlaneLink(requestedPlane);
      setDetailName(row.name);
      setTab(requestedPlane === 'sse' ? 'config' : 'summary');
    }
  }
  useEffect(() => {
    if (!requestedPlane || handledPlaneLink !== requestedPlane) return;
    const next = new URLSearchParams(searchParams);
    next.delete('plane');
    setSearchParams(next, { replace: true });
  }, [requestedPlane, handledPlaneLink, searchParams, setSearchParams]);

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
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
  const dormantViews = systemsLive && liveState ? views.filter((v) => v.live && !v.live.linked) : [];
  const activeViews = views.filter((v) => !dormantViews.includes(v));
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

  const retire = async () => {
    if (!cur || !curView?.planeId) {
      toast('cannot retire — this plane is not in the registry', { tone: 'danger' });
      return;
    }
    const ok = window.confirm(
      `Retire ${cur.name}? Stored credentials are cleared and the plane becomes unlinked.`,
    );
    if (!ok) return;
    const res = await retireSystem(curView.planeId);
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(`${cur.name} retired`, { description: res.message, tone: 'success' });
    setDetailName(null);
    await refresh();
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
    <div className="nt-systems">
      <ScreenHeader
        overline="Govern / Connected systems"
        title="Connected systems"
        subtitle="Live connector state and configuration."
        actions={
          <>
            {/* Design rule 1: the screen says which source answered and how
                fresh it is. Same vocabulary as SiteDetail so the portal does
                not invent a third phrasing for one state. */}
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-10)',
                color: 'var(--nd-text-muted)',
                letterSpacing: '.08em',
              }}
            >
              {systemsLive
                ? `LIVE · SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : 'NEVER'}`
                : 'DEMO FIXTURE'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void syncAll()} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync all'}
            </Button>
            <Button variant="primary" size="sm" onClick={() => openConnect()}>
              Connect a system
            </Button>
          </>
        }
      />

      {/* Authored on the demo section; derived from the registry's own 429s on
          a live one — never an incident on a plane that was never configured. */}
      {!systemsLive ? (
        <Alert tone="danger" title="Central Classic is throttling us" dismissible>
          <span style={{ fontSize: 13 }}>
            Two API clients share one token quota on the Classic tenant, so every third poll returns
            429 and inventory falls behind. Re-key the portal client, or retire the legacy scripts
            still using it.
          </span>
        </Alert>
      ) : pollFailure ? (
        <Alert tone="danger" title={pollFailure.title} dismissible>
          <span style={{ fontSize: 13 }}>{pollFailure.body}</span>
        </Alert>
      ) : throttle ? (
        <Alert tone="danger" title={throttle.title} dismissible>
          <span style={{ fontSize: 13 }}>{throttle.body}</span>
        </Alert>
      ) : null}

      {liveState === null ? (
        <div
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10.5,
            color: 'var(--nd-text-muted)',
          }}
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
            systemsLive && liveState
              ? `${linkedCount} LINKED · SELECT ONE FOR DETAIL`
              : `${data.systems.length} LINKED · SELECT ONE FOR DETAIL`
          }
        />
        <div className="nt-plane-table" role="table" aria-label="Connected planes">
          <div className="nt-plane-row nt-plane-row--head" role="row">
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
          {activeViews.map((v) => (
            <PlaneRow key={v.row.name} view={v} onOpen={openPlane} />
          ))}
        </div>
        {/* A plane that was never configured has nothing to report, and eight
            of them repeating "never / — / no credentials stored" buried the two
            that do. They collapse into one line that opens on demand. */}
        {dormantViews.length > 0 ? (
          <div className="nt-plane-dormant">
            <button
              type="button"
              className="nt-plane-dormant__toggle"
              aria-expanded={showDormant}
              onClick={() => setShowDormant((v) => !v)}
            >
              <span aria-hidden="true">{showDormant ? '−' : '+'}</span>
              {`${countOf(dormantViews.length, 'system')} not linked`}
              <small>no credentials stored — nothing is polled</small>
            </button>
            {showDormant ? (
              <div className="nt-plane-table" role="table" aria-label="Systems that are not linked">
                {dormantViews.map((v) => (
                  <PlaneRow key={v.row.name} view={v} onOpen={openPlane} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <Divider variant="flair" />

      {/* ---------------- sync history + permissions ---------------- */}
      <div
        className="nt-systems__lower-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: 34,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader label="Sync history" meta="LAST 2 HOURS" />
          {history.map((h, i) => (
            <div
              key={`${h.time}-${h.system}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '9px 0',
                borderBottom: '1px solid var(--nd-border-subtle)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10.5,
                  color: 'var(--nd-text-muted)',
                  width: 44,
                  flex: '0 0 44px',
                }}
              >
                {hhmm(h.time)}
              </span>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10.5,
                  color: 'var(--nd-text-secondary)',
                  width: 88,
                  flex: '0 0 88px',
                }}
              >
                {h.system}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  color: 'var(--nd-text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {h.what}
              </span>
              <Badge tone={h.tone}>{h.result}</Badge>
            </div>
          ))}
          {history.length === 0 ? (
            <div
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 10.5,
                color: 'var(--nd-text-muted)',
                padding: '9px 0',
              }}
            >
              no sync events recorded yet
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionHeader label="Permissions model" />
          <div style={{ fontSize: 13, color: 'var(--nd-text-secondary)', lineHeight: 1.6 }}>
            The portal never holds standing write access. Read scopes are permanent; write is
            brokered per change, expires in fifteen minutes, and is stamped with the ticket that
            authorised it.
          </div>
          {data.permissions.map((p) => (
            <div
              key={p.mode}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--nd-border-subtle)',
              }}
            >
              <Badge tone={p.tone}>{p.mode}</Badge>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-secondary)' }}>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 11,
                  color: 'var(--nd-text-muted)',
                }}
              >
                {curView.live?.note ?? cur.scopeNote}
              </span>
              {/* Why the plane is behind, when the registry knows: failed
                  polls record no error on the row itself, so without this the
                  drawer shows a stale plane with nothing to explain it. */}
              {curView.live && retryNote(curView.live) ? (
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 11,
                    color: 'var(--nd-warning)',
                  }}
                >
                  {retryNote(curView.live)}
                </span>
              ) : null}
            </div>

            <SegmentedControl options={TAB_OPTIONS} value={tab} onValueChange={(v) => setTab(v as DetailTab)} />

            {tab === 'summary' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: '8px 18px',
                  }}
                >
                  {curView.facts.map((f) => (
                    <div
                      key={f.k}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        padding: '7px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 9.5,
                          letterSpacing: '.12em',
                          textTransform: 'uppercase',
                          color: 'var(--nd-text-muted)',
                        }}
                      >
                        {f.k}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 11.5,
                          color: 'var(--nd-text-secondary)',
                        }}
                      >
                        {f.v}
                      </span>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="Sites on this plane" />
                  {cur.sites.map((x) => {
                    const siteId = x.siteId;
                    return (
                      <div
                        key={x.name}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 0',
                          borderBottom: '1px solid var(--nd-border-subtle)',
                        }}
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
                            style={{
                              flex: 1,
                              minWidth: 0,
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontSize: 12.5,
                              color: 'var(--nd-accent-text)',
                            }}
                          >
                            {x.name}
                          </button>
                        ) : (
                          <span
                            style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-primary)' }}
                          >
                            {x.name}
                          </span>
                        )}
                        <span
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 10.5,
                            color: 'var(--nd-text-muted)',
                          }}
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

                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="Live on this plane" />
                  {cur.live.map((l) => (
                    <div
                      key={l.label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 12,
                          color: 'var(--nd-text-primary)',
                          width: 80,
                          flex: '0 0 80px',
                        }}
                      >
                        {l.value}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-secondary)' }}>
                        {l.label}
                      </span>
                    </div>
                  ))}
                  {cur.live.length === 0 ? (
                    <NothingReported label="no sessions, devices or alerts sourced here yet" />
                  ) : null}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 12 }}>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="API calls" meta="LAST 20 MINUTES" />
                  {curCalls.map((c, i) => (
                    <div
                      key={`${c.time}-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '7px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                          width: 44,
                          flex: '0 0 44px',
                        }}
                      >
                        {hhmm(c.time)}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 11,
                          color: 'var(--nd-text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.path}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                          width: 56,
                          textAlign: 'right',
                        }}
                      >
                        {c.ms}
                      </span>
                      <Badge tone={c.tone}>{c.code}</Badge>
                    </div>
                  ))}
                  {curCalls.length === 0 ? (
                    <div
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 10.5,
                        color: 'var(--nd-text-muted)',
                        padding: '7px 0',
                      }}
                    >
                      no calls recorded yet
                    </div>
                  ) : null}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="Recent events" />
                  {cur.events.map((e, i) => (
                    <div
                      key={`${e.time}-${i}`}
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
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                          width: 44,
                          flex: '0 0 44px',
                        }}
                      >
                        {hhmm(e.time)}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, color: 'var(--nd-text-primary)', lineHeight: 1.4 }}>
                          {e.what}
                        </div>
                        <div
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 10,
                            color: 'var(--nd-text-muted)',
                          }}
                        >
                          {e.who}
                        </div>
                      </div>
                    </div>
                  ))}
                  {cur.events.length === 0 ? (
                    <NothingReported label="no brokered writes, token rotations or cluster changes recorded" />
                  ) : null}
                </div>
              </div>
            ) : null}

            {tab === 'config' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {curView?.planeId === 'sse' ? (
                  curView.live?.linked ? (
                    <SseInventoryPanel canWrite={curView.live?.capabilities?.directWrite === true} />
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="What the portal pulls" />
                  {cur.pulls.map((p) => (
                    <div
                      key={p.what}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-primary)' }}>
                        {p.what}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                          width: 96,
                          textAlign: 'right',
                        }}
                      >
                        {p.every}
                      </span>
                      <Badge tone={p.tone}>{p.mode}</Badge>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <SectionHeader label="Credential & connection" />
                  <Code block>{cur.configText}</Code>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <SectionHeader label="Actions" />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
                    <Button variant="danger" size="sm" onClick={() => void retire()}>
                      Retire plane
                    </Button>
                  </div>
                  {!cur.consoleUrl ? (
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 10.5,
                        color: 'var(--nd-text-muted)',
                      }}
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
        title={`Configure ${selectedEntry.label}`}
      >
        <form
          ref={connectorFormRef}
          onSubmit={(event) => event.preventDefault()}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} aria-label="Declared capabilities">
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
              <span style={{ fontSize: 13 }}>{testResult.message}</span>
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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
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
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--nd-text-secondary)' }}>
              Advanced policy
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }}>
              <Checkbox
                label="Verify TLS certificate"
                checked={draft.verifyTls}
                onChange={(e) => updateDraft({ ...draft, verifyTls: e.target.checked })}
              />
              {!draft.verifyTls ? <Alert tone="warning" title="TLS verification disabled" /> : null}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
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
              <span style={{ fontSize: 13 }}>Policy or credentials changed after the authenticated probe.</span>
            </Alert>
          ) : null}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
  );
}
