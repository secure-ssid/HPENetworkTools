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
 * actually on screen, never a literal. A drawer site row that names a real
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
  SystemCredentialPayload,
  SystemsData,
  SystemsState,
} from '../api/client';
import {
  CONNECT_ENDPOINTS,
  CONNECT_ENDPOINT_KEY,
  CONNECT_FIELDS,
  CONNECT_HIDE_CLIENT_CREDENTIALS,
  CONNECT_TYPE_OPTIONS,
  hhmmLocal as hhmm,
  countOf,
} from '@hpe/shared';
import type { SystemRow, SystemTypeKey } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { SseInventoryPanel } from './SseInventoryPanel';
import { CentralWebhooksPanel } from './CentralWebhooksPanel';
import { AssistantSection } from './systems/AssistantSection';
import { IdentityProviderSection } from './systems/IdentityProviderSection';
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
  BROKERED_WRITE_SCOPE_LABEL,
  CENTRAL_REGIONS,
  CredentialSnapshot,
  DEFAULT_SCOPES,
  DetailTab,
  HEALTH_TONE,
  PLANE_ID_BY_NAME,
  PlaneView,
  SSE_WRITE_SCOPE_LABEL,
  ScopeFlags,
  TAB_OPTIONS,
  mergedFacts,
  retryNote,
  sameCredentialSnapshot,
  staleTitle,
  storedEndpoint,
  storedScopes,
} from './systems/facts';
import '../app/app.css';









































export default function Systems() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();

  const [data, setData] = useState<SystemsData | null>(null);
  const [liveState, setLiveState] = useState<SystemsState | null>(null);

  const [detailName, setDetailName] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('summary');
  const [showDormant, setShowDormant] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [newType, setNewType] = useState<SystemTypeKey>('central');
  const [displayName, setDisplayName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  /** True when the user has selected "Custom URL…" in a region-picker dropdown. */
  const [endpointCustomMode, setEndpointCustomMode] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  // The per-plane credential fields CONNECT_FIELDS declares, keyed by the
  // settings key the adapter's isComplete() actually reads.
  const [extraCreds, setExtraCreds] = useState<Record<string, string>>({});
  const [scopes, setScopes] = useState<ScopeFlags>(DEFAULT_SCOPES);
  const [testing, setTesting] = useState(false);
  const [testedOk, setTestedOk] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const credentialVersionRef = useRef(0);
  const currentCredentialSnapshotRef = useRef<CredentialSnapshot | null>(null);
  const successfulTestRef = useRef<CredentialSnapshot | null>(null);
  // Set when a field change invalidates a PASSED test — surfaced as a warning
  // so a green-then-edited drawer never looks saved when it cannot be.
  const [retestNeeded, setRetestNeeded] = useState(false);

  const refresh = async () => {
    const [d, s] = await Promise.all([getSystems(), getSystemsState()]);
    setData(d);
    setLiveState(s);
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      const [d, s] = await Promise.all([getSystems(), getSystemsState()]);
      if (live) {
        setData(d);
        setLiveState(s);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const requestedPlane = searchParams.get('plane');
  useEffect(() => {
    if (!data || !requestedPlane) return;
    const row = data.systems.find(
      (system) =>
        system.planeId === requestedPlane ||
        PLANE_ID_BY_NAME[system.name] === requestedPlane,
    );
    if (!row) return;
    setDetailName(row.name);
    setTab(requestedPlane === 'sse' ? 'config' : 'summary');
    const next = new URLSearchParams(searchParams);
    next.delete('plane');
    setSearchParams(next, { replace: true });
  }, [data, requestedPlane, searchParams, setSearchParams]);

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
    type: SystemTypeKey;
    name: string;
    endpoint?: string;
    scopes?: ScopeFlags;
  }) => {
    credentialVersionRef.current += 1;
    successfulTestRef.current = null;
    setNewType(prefill?.type ?? 'central');
    setDisplayName(prefill?.name ?? '');
    setEndpoint(prefill?.endpoint ?? '');
    setEndpointCustomMode(false);
    setClientId('');
    setClientSecret('');
    setExtraCreds({});
    // A new connection always starts write-off (safe default); a re-key
    // prefills — and thereby preserves — the plane's existing scopes unless
    // the caller passed none (storedScopes() falls back to DEFAULT_SCOPES
    // itself when nothing was ever recorded).
    setScopes(prefill?.scopes ?? DEFAULT_SCOPES);
    setTesting(false);
    setTestedOk(false);
    setTestResult(null);
    setRetestNeeded(false);
    setDetailName(null);
    setAddOpen(true);
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

  const selectedScopes = (): string[] => {
    const out: string[] = [];
    if (scopes.inventory) out.push('read:inventory');
    if (scopes.clientsAuth) out.push('read:clients-auth');
    if (scopes.configLicences) out.push('read:config-licences');
    if (scopes.write) out.push('write:brokered');
    return out;
  };

  /* Saved under the exact keys each adapter's isComplete() reads (shared
   * CONNECT_ENDPOINT_KEY / CONNECT_FIELDS) — a record written under any other
   * key links the plane to a stub that never syncs. */
  const credPayload = (): SystemCredentialPayload => {
    const out: SystemCredentialPayload = {};
    if (displayName.trim()) out.displayName = displayName.trim();
    if (endpoint.trim()) out[CONNECT_ENDPOINT_KEY[newType]] = endpoint.trim();
    // Token-only planes (CONNECT_HIDE_CLIENT_CREDENTIALS, e.g. SSE) never
    // render this pair, so it must never be serialized for them either — a
    // stale clientId/clientSecret left over from an earlier type selection
    // is invisible in the drawer but would otherwise still ride along in the
    // saved/tested payload.
    if (!CONNECT_HIDE_CLIENT_CREDENTIALS.includes(newType)) {
      if (clientId.trim()) out.clientId = clientId.trim();
      if (clientSecret.trim()) out.clientSecret = clientSecret.trim();
    }
    CONNECT_FIELDS[newType].forEach((f) => {
      const v = (extraCreds[f.key] ?? '').trim();
      if (v) out[f.key] = v;
    });
    // Unlike optional credential fields, the scope controls are an explicit
    // complete selection. Always serialize their exact array, including [],
    // so test/save binding can distinguish full revocation from omission.
    out.scopes = selectedScopes();
    return out;
  };

  const credentialSnapshot = (): CredentialSnapshot => ({
    plane: newType,
    credentials: credPayload(),
  });
  currentCredentialSnapshotRef.current = credentialSnapshot();

  const testConnection = async () => {
    if (testing) return;
    const request = credentialSnapshot();
    const requestVersion = credentialVersionRef.current;
    setTesting(true);
    setTestResult(null);
    setTestedOk(false);
    setRetestNeeded(false);
    successfulTestRef.current = null;
    const res = await testSystem(request.plane, request.credentials);
    setTesting(false);
    if (
      requestVersion !== credentialVersionRef.current ||
      !sameCredentialSnapshot(request, currentCredentialSnapshotRef.current)
    ) {
      setTestResult(null);
      setTestedOk(false);
      successfulTestRef.current = null;
      if (res.ok) setRetestNeeded(true);
      return;
    }
    setTestResult(res);
    setTestedOk(res.ok);
    successfulTestRef.current = res.ok ? request : null;
  };

  const saveAndIndex = async () => {
    const tested = successfulTestRef.current;
    const current = credentialSnapshot();
    if (!tested || !testedOk || !sameCredentialSnapshot(tested, current)) {
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
    const res = await saveSystemCredentials(tested.plane, tested.credentials);
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
    setAddOpen(false);
    await refresh();
  };

  const endpointVariant = CONNECT_ENDPOINTS[newType];

  return (
    <div className="nt-systems">
      <ScreenHeader
        overline="Govern / Connected systems"
        title="Connected systems"
        subtitle="Every plane the portal speaks to, what it is allowed to do there, and when it last succeeded."
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
                        curView.planeId
                          ? openConnect({
                              type: curView.planeId,
                              name: cur.name,
                              endpoint: storedEndpoint(cur, curView.planeId),
                              scopes: storedScopes(cur, curView.live),
                            })
                          : undefined
                      }
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
        onOpenChange={setAddOpen}
        width="lg"
        title="Connect a system"
        description={
          newType === 'sse'
            ? 'The portal needs read scope to index SSE objects. Direct write applies reviewed SSE object mutations followed by tenant-wide Commit.'
            : 'The portal needs read scope to index devices, and an optional brokered write scope for changes.'
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <FormField label="System type" help="Pick the plane this credential belongs to.">
            <Select
              options={CONNECT_TYPE_OPTIONS}
              value={newType}
              onValueChange={(v) => {
                setNewType(v as SystemTypeKey);
                // Another plane's fields would be saved under keys this one
                // never reads, and a hidden-for-this-plane clientId/secret
                // (e.g. switching onto SSE) must not silently ride along
                // invisibly either — every shared and extra credential field,
                // the endpoint, and the scope selection all belong to the
                // PRIOR plane and must not leak onto the new one. A re-key's
                // preserved scopes are prior-plane state too, so a mid-drawer
                // type change resets to the safe connect-drawer defaults
                // rather than carrying them across.
                setEndpoint('');
                setEndpointCustomMode(false);
                setClientId('');
                setClientSecret('');
                setExtraCreds({});
                setScopes(DEFAULT_SCOPES);
                invalidate();
              }}
            />
          </FormField>

          <FormField label="Display name">
            <Input
              placeholder="Central — Meridian production"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                invalidate();
              }}
            />
          </FormField>

          {newType === 'central' && (
            <FormField label="Region" help="Fills the gateway URL; choose Custom to paste your own.">
              <Select
                aria-label="Central region"
                size="md"
                options={[...CENTRAL_REGIONS, { value: 'custom', label: 'Custom gateway…' }]}
                value={CENTRAL_REGIONS.some((r) => r.value === endpoint) ? endpoint : 'custom'}
                onValueChange={(v) => {
                  if (v !== 'custom') setEndpoint(v);
                  invalidate();
                }}
              />
            </FormField>
          )}

          <FormField label={endpointVariant.label} help={endpointVariant.help}>
            {endpointVariant.options ? (
              /* Region picker — pre-fills the URL so the operator never has to
                 look it up. "Custom URL…" reveals a text field below. */
              <Select
                value={endpointCustomMode ? '__custom__' : (endpoint || '')}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '__custom__') {
                    setEndpointCustomMode(true);
                    setEndpoint('');
                  } else {
                    setEndpointCustomMode(false);
                    setEndpoint(v);
                  }
                  invalidate();
                }}
              >
                <option value="">— select a region —</option>
                {endpointVariant.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                <option value="__custom__">Custom URL…</option>
              </Select>
            ) : (
              <Input
                mono
                placeholder={endpointVariant.hint}
                value={endpoint}
                onChange={(e) => {
                  setEndpoint(e.target.value);
                  invalidate();
                }}
              />
            )}
          </FormField>

          {/* Custom URL input — only shown when "Custom URL…" is selected in
              a region-picker dropdown (e.g. for private/unlisted clusters). */}
          {endpointVariant.options && endpointCustomMode && (
            <FormField
              label="Custom gateway URL"
              help="Hostname or full URL for a private or unlisted cluster."
            >
              <Input
                mono
                placeholder={endpointVariant.hint}
                value={endpoint}
                onChange={(e) => {
                  setEndpoint(e.target.value);
                  invalidate();
                }}
              />
            </FormField>
          )}

          {/* Token-only planes (e.g. SSE) have no use for the shared Client
              ID/secret pair — hidden so a save can never write a value under
              a key that plane's isComplete() does not read. */}
          {!CONNECT_HIDE_CLIENT_CREDENTIALS.includes(newType) && (
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
            >
              <FormField label="Client ID">
                <Input
                  mono
                  placeholder="a41f…"
                  value={clientId}
                  onChange={(e) => {
                    setClientId(e.target.value);
                    invalidate();
                  }}
                />
              </FormField>
              <FormField label="Client secret" help="Stored in the workspace vault, never shown again.">
                <Input
                  mono
                  type="password"
                  placeholder="••••••••••••"
                  value={clientSecret}
                  onChange={(e) => {
                    setClientSecret(e.target.value);
                    invalidate();
                  }}
                />
              </FormField>
            </div>
          )}

          {/* What this plane's adapter needs beyond the endpoint and the
              client pair — without these the record saves, the plane links,
              and the poller runs a stub that never returns a row. */}
          {CONNECT_FIELDS[newType].map((f) => (
            <FormField
              key={f.key}
              label={f.optional ? `${f.label} — optional` : f.label}
              help={f.help}
            >
              <Input
                mono
                type={f.secret ? 'password' : undefined}
                placeholder={f.secret ? '••••••••••••' : f.key}
                value={extraCreds[f.key] ?? ''}
                onChange={(e) => {
                  setExtraCreds({ ...extraCreds, [f.key]: e.target.value });
                  invalidate();
                }}
              />
            </FormField>
          ))}

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '14px 0',
              borderTop: '1px solid var(--nd-border-subtle)',
              borderBottom: '1px solid var(--nd-border-subtle)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 10,
                letterSpacing: '.12em',
                textTransform: 'uppercase',
                color: 'var(--nd-text-muted)',
              }}
            >
              Scopes
            </span>
            <Checkbox
              label="Read inventory, sites and topology"
              checked={scopes.inventory}
              onChange={(e) => {
                setScopes({ ...scopes, inventory: e.target.checked });
                invalidate();
              }}
            />
            <Checkbox
              label="Read clients, sessions and auth events"
              checked={scopes.clientsAuth}
              onChange={(e) => {
                setScopes({ ...scopes, clientsAuth: e.target.checked });
                invalidate();
              }}
            />
            <Checkbox
              label="Read configuration and licences"
              checked={scopes.configLicences}
              onChange={(e) => {
                setScopes({ ...scopes, configLicences: e.target.checked });
                invalidate();
              }}
            />
            <Checkbox
              label={
                newType === 'sse'
                  ? SSE_WRITE_SCOPE_LABEL
                  : BROKERED_WRITE_SCOPE_LABEL
              }
              checked={scopes.write}
              onChange={(e) => {
                setScopes({ ...scopes, write: e.target.checked });
                invalidate();
              }}
            />
            {newType === 'sse' ? (
              <span
                style={{
                  marginLeft: 24,
                  fontSize: 12,
                  color: 'var(--nd-text-muted)',
                }}
              >
                Each reviewed mutation is sent directly to SSE, then the portal runs tenant-wide
                Commit.
              </span>
            ) : null}
          </div>

          {testResult ? (
            <Alert
              tone={testResult.ok ? 'success' : 'danger'}
              title={testResult.ok ? 'Connection succeeded' : 'Connection failed'}
            >
              <span style={{ fontSize: 13 }}>{testResult.message}</span>
            </Alert>
          ) : null}

          {retestNeeded && !testResult ? (
            <Alert tone="warning" title="Re-test required">
              <span style={{ fontSize: 13 }}>
                The credentials changed after the successful test — nothing is saved yet. Run Test
                connection again, then Save and index.
              </span>
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
            <Button variant="ghost" size="md" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
          </div>

          <div
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 10.5,
              color: 'var(--nd-text-muted)',
              lineHeight: 1.6,
            }}
          >
            Indexing a new plane takes 2–6 minutes. Devices already claimed elsewhere are flagged as
            double-claimed rather than duplicated.
          </div>
        </div>
      </Drawer>
    </div>
  );
}
