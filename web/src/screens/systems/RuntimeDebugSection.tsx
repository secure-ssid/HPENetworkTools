/**
 * Runtime debug panel — GET /api/debug/runtime.
 * Process/plane/poller + reconcile integrity counts only; no secrets or vendor payloads.
 * Filter/share via ?rtFilter=&rtPlane= on the Systems URL.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, SectionHeader, Select, Skeleton, Spinner, useToast } from '../../nightdesk';
import { apiFetch, serverMessage } from '../../api/core';
import { exportTableCsv } from '../../lib/csv';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import { systemsSectionDomId } from './share';

interface RuntimeIntegrity {
  devices: number;
  doubleClaimed: number;
  unclaimed: number;
}

interface RuntimeDebug {
  ok: boolean;
  at: string;
  process: {
    pid: number;
    node: string;
    platform: string;
    uptimeSec: number;
    memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  };
  portal: {
    demoMode: boolean;
    blendLive: boolean;
    auth: string;
    pollIntervalSec: number;
    configMode: boolean;
  };
  dataDir: { path: string; writable: boolean | 'unknown' };
  poller: { running: boolean | null; contributionPlanes: string[] };
  notifier: {
    sampling: { running: boolean; lastSampleAt: string | null; trackedGroups: number };
    deliveryLogSize: number;
    outboxSize: number;
  };
  terminal: { openSessions: number };
  integrity?: RuntimeIntegrity;
  planes: Array<{
    id: string;
    linked: boolean;
    health: string;
    stale: boolean;
    reason: string | null;
    ageSec: number | null;
    lastSync: string | null;
    noteChars: number;
  }>;
}

type PlaneFilter = 'all' | 'linked' | 'unlinked' | 'healthy' | 'degraded' | 'stale';

const FILTER_OPTIONS: Array<{ value: PlaneFilter; label: string }> = [
  { value: 'all', label: 'All planes' },
  { value: 'linked', label: 'Linked' },
  { value: 'unlinked', label: 'Unlinked' },
  { value: 'healthy', label: 'Healthy' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'stale', label: 'Stale' },
];

function parseFilter(raw: string | null): PlaneFilter {
  if (
    raw === 'linked' ||
    raw === 'unlinked' ||
    raw === 'healthy' ||
    raw === 'degraded' ||
    raw === 'stale'
  ) {
    return raw;
  }
  return 'all';
}

function matchesFilter(
  p: RuntimeDebug['planes'][number],
  filter: PlaneFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'linked':
      return p.linked;
    case 'unlinked':
      return !p.linked;
    case 'healthy':
      return p.linked && p.health === 'healthy' && !p.stale;
    case 'degraded':
      return p.linked && (p.health === 'degraded' || p.health === 'warning');
    case 'stale':
      return p.stale;
    default:
      return true;
  }
}

function mb(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

interface PlaneHealth {
  ok: boolean;
  plane: string;
  linked: boolean;
  health: string;
  stale: boolean;
  reason: string | null;
  lastSync: string | null;
  ageSec: number | null;
  noteChars: number;
  recentCalls: Array<{ time: string; path: string; ms: number; code: string }>;
  recentEvents: Array<{ time: string; what: string; who: string }>;
}

interface HealthDeep {
  ok: boolean;
  status: string;
  uptimeSec: number;
  auth: string;
  demoMode: boolean;
  degradedPlanes: string[];
  deep?: {
    node: string;
    memory: { rss: number; heapUsed: number; heapTotal: number };
    pollIntervalSec: number;
    notifier: {
      sampling: { running: boolean; lastSampleAt: string | null; trackedGroups: number };
      deliveryLogSize: number;
      outboxSize: number;
    };
  };
  deepWithheld?: boolean;
}

function viewLink(filter: PlaneFilter, planeId: string | null): string {
  const next = new URLSearchParams();
  if (filter !== 'all') next.set('rtFilter', filter);
  if (planeId) next.set('rtPlane', planeId);
  const qs = next.toString();
  return `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
}

export function RuntimeDebugSection() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseFilter(searchParams.get('rtFilter'));
  const rtPlane = searchParams.get('rtPlane');

  const [data, setData] = useState<RuntimeDebug | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [planeHealth, setPlaneHealth] = useState<PlaneHealth | null>(null);
  const [planeHealthError, setPlaneHealthError] = useState<string | null>(null);
  const [planeHealthLoading, setPlaneHealthLoading] = useState(false);
  const [healthDeep, setHealthDeep] = useState<HealthDeep | null>(null);
  const [healthDeepError, setHealthDeepError] = useState<string | null>(null);
  const [healthDeepLoading, setHealthDeepLoading] = useState(false);
  const [openedFromLink, setOpenedFromLink] = useState<string | null>(null);

  const setFilter = (next: PlaneFilter) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'all') params.delete('rtFilter');
    else params.set('rtFilter', next);
    setSearchParams(params, { replace: true });
  };

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/debug/runtime');
      if (!r.ok) {
        setError(await serverMessage(r, `HTTP ${r.status}`));
        setData(null);
        return;
      }
      const body = (await r.json()) as RuntimeDebug;
      if (!body?.ok || !body.process) {
        setError('Unexpected runtime payload');
        setData(null);
        return;
      }
      setData(body);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const r = await apiFetch('/api/debug/runtime');
        if (!r.ok) {
          if (active) {
            setError(await serverMessage(r, `HTTP ${r.status}`));
            setData(null);
          }
          return;
        }
        const body = (await r.json()) as RuntimeDebug;
        if (!body?.ok || !body.process) {
          if (active) {
            setError('Unexpected runtime payload');
            setData(null);
          }
          return;
        }
        if (active) {
          setData(body);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError((err as Error).message);
          setData(null);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadPlaneHealth = useCallback(async (planeId: string) => {
    setPlaneHealthLoading(true);
    setPlaneHealthError(null);
    try {
      const r = await apiFetch(`/api/systems/${encodeURIComponent(planeId)}/health`);
      if (!r.ok) {
        setPlaneHealth(null);
        setPlaneHealthError(await serverMessage(r, `HTTP ${r.status}`));
        return;
      }
      const body = (await r.json()) as PlaneHealth;
      if (!body?.ok) {
        setPlaneHealth(null);
        setPlaneHealthError('Unexpected plane health payload');
        return;
      }
      setPlaneHealth(body);
    } catch (err) {
      setPlaneHealth(null);
      setPlaneHealthError((err as Error).message);
    } finally {
      setPlaneHealthLoading(false);
    }
  }, []);

  const selectPlane = (planeId: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('rtPlane', planeId);
    setSearchParams(params, { replace: true });
    void loadPlaneHealth(planeId);
  };

  // Deep-link: open plane health once when ?rtPlane= is present.
  useEffect(() => {
    if (!rtPlane || openedFromLink === rtPlane) return;
    queueMicrotask(() => {
      setOpenedFromLink(rtPlane);
      void loadPlaneHealth(rtPlane);
    });
  }, [rtPlane, openedFromLink, loadPlaneHealth]);

  const loadHealthDeep = async () => {
    setHealthDeepLoading(true);
    setHealthDeepError(null);
    try {
      const r = await apiFetch('/api/health?deep=1');
      if (!r.ok) {
        setHealthDeep(null);
        setHealthDeepError(await serverMessage(r, `HTTP ${r.status}`));
        return;
      }
      const body = (await r.json()) as HealthDeep;
      if (!body?.ok) {
        setHealthDeep(null);
        setHealthDeepError('Unexpected health payload');
        return;
      }
      setHealthDeep(body);
    } catch (err) {
      setHealthDeep(null);
      setHealthDeepError((err as Error).message);
    } finally {
      setHealthDeepLoading(false);
    }
  };

  const filteredPlanes = useMemo(() => {
    if (!data) return [];
    return data.planes.filter((p) => matchesFilter(p, filter));
  }, [data, filter]);

  const integrity = data?.integrity;
  const selectedPlaneId = planeHealth?.plane ?? rtPlane;

  return (
    <div className="nt-systems-section nt-section-panel nt-stack nt-gap-12" id={systemsSectionDomId('runtime-debug')} data-legacy-id="runtime-debug">
      <div className="nt-filter-bar nt-gap-10">
        <SectionHeader label="Runtime debug" meta="PROCESS · PLANES · INTEGRITY · NO SECRETS" />
        <div className="nt-plane-theater" role="note">HPE Network Tools · runtime theater · process · integrity · no secrets</div>
      <div className="nt-status-ribbon nt-runtime-ribbon" role="status" aria-label="Runtime status ribbon">
        <span className="nt-status-ribbon__item">runtime · process</span>
        <span className="nt-status-ribbon__item">integrity · no secrets</span>
        <span className="nt-status-ribbon__item">debug lane</span>
      </div>
        <Select
          size="sm"
          aria-label="Filter planes"
          value={filter}
          onChange={(e) => setFilter(e.target.value as PlaneFilter)}
        >
          {FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button variant="ghost" size="sm" onClick={() => { void load(); }} disabled={loading}>
          {loading ? <Spinner size="sm" /> : 'Refresh'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { void loadHealthDeep(); }} disabled={healthDeepLoading}>
          {healthDeepLoading ? <Spinner size="sm" /> : 'Health deep'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void (async () => {
              const url = viewLink(filter, selectedPlaneId);
              try {
                await navigator.clipboard.writeText(url);
                toast('View link copied', {
                  description:
                    filter !== 'all' || selectedPlaneId
                      ? [filter !== 'all' ? `rtFilter=${filter}` : null, selectedPlaneId ? `rtPlane=${selectedPlaneId}` : null]
                          .filter(Boolean)
                          .join(' · ')
                      : 'runtime debug (unfiltered)',
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
        {data ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
                  } catch {
                    /* ignore */
                  }
                })();
              }}
            >
              Copy JSON
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const planesForCsv = filteredPlanes.length > 0 ? filteredPlanes : data.planes;
                const integ = data.integrity ?? { devices: 0, doubleClaimed: 0, unclaimed: 0 };
                const n = exportTableCsv(
                  'connector-integrity.csv',
                  [
                    'kind',
                    'id',
                    'linked',
                    'health',
                    'stale',
                    'reason',
                    'ageSec',
                    'lastSync',
                    'noteChars',
                    'count',
                  ],
                  [
                    ['integrity', 'devices', '', '', '', '', '', '', '', integ.devices],
                    ['integrity', 'doubleClaimed', '', '', '', '', '', '', '', integ.doubleClaimed],
                    ['integrity', 'unclaimed', '', '', '', '', '', '', '', integ.unclaimed],
                    ...planesForCsv.map((p) => [
                      'plane',
                      p.id,
                      p.linked,
                      p.health,
                      p.stale,
                      p.reason ?? '',
                      p.ageSec ?? '',
                      p.lastSync ?? '',
                      p.noteChars,
                      '',
                    ]),
                  ],
                );
                toast(`Exported ${n} integrity row${n === 1 ? '' : 's'}`, {
                  description: 'connector-integrity.csv — reconcile counts + plane facts only, no secrets.',
                });
              }}
            >
              Export integrity CSV
            </Button>
            {!data.portal.demoMode ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    /* Same plane slice as the filter Select / ?rtFilter= so
                     * server CSV never dumps unlinked planes while the operator
                     * is looking at degraded only. Integrity tallies always ship. */
                    const exportQs = new URLSearchParams();
                    if (filter !== 'all') exportQs.set('filter', filter);
                    const exportPath = exportQs.toString()
                      ? `/api/debug/runtime/export?${exportQs.toString()}`
                      : '/api/debug/runtime/export';
                    const res = await downloadApiCsv(exportPath, 'connector-integrity-live.csv');
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description:
                          filter !== 'all'
                            ? `connector-integrity-live.csv — filter=${filter}; counts + plane facts, no secrets.`
                            : 'connector-integrity-live.csv — counts + plane link/health only, no secrets.',
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
        ) : null}
      </div>

      {healthDeepError ? (
        <Alert tone="danger" title="Health deep unavailable">
          <span className="nt-fs-13">{healthDeepError}</span>
        </Alert>
      ) : null}
      {healthDeep ? (
        <div
          className="nt-row nt-mono-11 nt-debug-note"
        >
          <span>
            GET /api/health?deep=1 · status {healthDeep.status} · up {fmtUptime(healthDeep.uptimeSec)} · auth{' '}
            {healthDeep.auth}
            {healthDeep.demoMode ? ' · demo' : ' · live'}
          </span>
          {healthDeep.deepWithheld ? (
            <span className="nt-hint-muted nt-warning-text">
              deep withheld — sign in when OIDC is on (no process facts for strangers)
            </span>
          ) : null}
          {healthDeep.deep ? (
            <span>
              node {healthDeep.deep.node} · heap {mb(healthDeep.deep.memory.heapUsed)} /{' '}
              {mb(healthDeep.deep.memory.heapTotal)} · poll {healthDeep.deep.pollIntervalSec}s · deliveries{' '}
              {healthDeep.deep.notifier.deliveryLogSize} · outbox {healthDeep.deep.notifier.outboxSize}
            </span>
          ) : null}
          {healthDeep.degradedPlanes.length > 0 ? (
            <span>degraded planes: {healthDeep.degradedPlanes.join(', ')}</span>
          ) : (
            <span>no degraded linked planes</span>
          )}
        </div>
      ) : null}

      {error ? (
        <Alert tone="danger" title="Runtime debug unavailable">
          <span className="nt-fs-13">{error}</span>
        </Alert>
      ) : null}

      {loading && !data ? (
        <div className="nt-debug-wake" aria-busy="true" aria-live="polite">
          <span className="nt-chat-pending__pulse" aria-hidden />
          <div className="nt-stack nt-gap-8 nt-flex-1">
            <Skeleton height={14} width="42%" />
            <Skeleton height={12} width="68%" />
            <div className="nt-metrics-3 nt-grid-160">
              <Skeleton height={56} />
              <Skeleton height={56} />
              <Skeleton height={56} />
            </div>
          </div>
          <span className="nt-hint-muted nt-chat-pending__label">HPE Network Tools · runtime wake…</span>
        </div>
      ) : null}

      {data ? (
        <div className="nt-stack nt-gap-10">
          <div className="nt-wrap-6 nt-gap-8 nt-row-center">
            <Badge tone={data.portal.demoMode ? 'warning' : 'success'}>
              {data.portal.demoMode ? 'demo' : 'live'}
            </Badge>
            <Badge tone="neutral">auth {data.portal.auth}</Badge>
            <Badge tone="neutral">node {data.process.node}</Badge>
            <Badge tone="neutral">up {fmtUptime(data.process.uptimeSec)}</Badge>
            <span className="nt-hint-muted">
              heap {mb(data.process.memory.heapUsed)} / {mb(data.process.memory.heapTotal)} · rss {mb(data.process.memory.rss)}
            </span>
          </div>

          {integrity ? (
            <div className="nt-wrap-6 nt-gap-8 nt-row-center">
              <Badge tone="neutral">{integrity.devices} devices</Badge>
              <Badge tone={integrity.doubleClaimed > 0 ? 'warning' : 'neutral'}>
                {integrity.doubleClaimed} double-claimed
              </Badge>
              <Badge tone={integrity.unclaimed > 0 ? 'warning' : 'neutral'}>
                {integrity.unclaimed} unclaimed
              </Badge>
              <span className="nt-hint-muted">
                reconcile tallies (counts only — same source as Devices)
              </span>
            </div>
          ) : null}

          <div className="nt-mono-11 nt-text-sec nt-lh-15">
            <div>
              data dir: {data.dataDir.path} · writable:{' '}
              {data.dataDir.writable === 'unknown' ? '?' : data.dataDir.writable ? 'yes' : 'no'}
            </div>
            <div>
              poller: {data.poller.running === null ? 'n/a' : data.poller.running ? 'running' : 'stopped'} · planes
              contributing: {data.poller.contributionPlanes.join(', ') || 'none'} · interval{' '}
              {data.portal.pollIntervalSec}s
            </div>
            <div>
              notifier: sampling {data.notifier.sampling.running ? 'on' : 'off'} · tracked{' '}
              {data.notifier.sampling.trackedGroups} · delivery log {data.notifier.deliveryLogSize} · outbox{' '}
              {data.notifier.outboxSize} · shells open {data.terminal.openSessions}
            </div>
          </div>

          <div className="nt-metrics-3 nt-grid-160">
            {filteredPlanes.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { selectPlane(p.id); }}
                className="nt-debug-card-left"
              >
                <div className="nt-row-center nt-gap-6 nt-mb-4">
                  <span className="nt-configure-row__name-primary">
                    {p.id}
                  </span>
                  <Badge
                    tone={
                      !p.linked
                        ? 'neutral'
                        : p.health === 'healthy' && !p.stale
                          ? 'success'
                          : p.health === 'degraded' || p.stale
                            ? 'danger'
                            : 'warning'
                    }
                  >
                    {!p.linked ? 'unlinked' : p.stale ? 'stale' : p.health}
                  </Badge>
                </div>
                <div className="nt-hint-muted">
                  {p.reason ?? '—'}
                  {p.ageSec != null ? ` · ${p.ageSec}s` : ''}
                  {p.noteChars > 0 ? ` · note ${p.noteChars}c` : ''}
                </div>
              </button>
            ))}
          </div>
          {filteredPlanes.length === 0 ? (
            <div className="nt-hint-muted">No planes match filter “{filter}”.</div>
          ) : null}
          {planeHealthLoading ? (
            <div className="nt-debug-wake nt-debug-wake--compact" aria-busy="true">
              <span className="nt-chat-pending__pulse" aria-hidden />
              <div className="nt-stack nt-gap-6 nt-flex-1">
                <Skeleton height={12} width="36%" />
                <Skeleton height={10} width="54%" />
              </div>
            </div>
          ) : null}
          {planeHealthError ? (
            <Alert tone="danger" title="Plane health unavailable">
              <span className="nt-fs-13">{planeHealthError}</span>
            </Alert>
          ) : null}
          {planeHealth ? (
            <div
              className="nt-debug-card-row"
            >
              <div className="nt-wrap-6 nt-gap-8 nt-row-center">
                <span className="nt-mono-11 nt-fs-12">{planeHealth.plane}</span>
                <Badge tone={planeHealth.linked ? (planeHealth.stale ? 'danger' : 'success') : 'neutral'}>
                  {planeHealth.linked ? (planeHealth.stale ? 'stale' : planeHealth.health) : 'unlinked'}
                </Badge>
                <span className="nt-hint-muted">
                  {planeHealth.reason ?? '—'}
                  {planeHealth.ageSec != null ? ` · ${planeHealth.ageSec}s` : ''}
                </span>
              </div>
              <div className="nt-mono-11 nt-text-sec">
                recent calls ({planeHealth.recentCalls.length})
              </div>
              {planeHealth.recentCalls.length === 0 ? (
                <div className="nt-hint-muted">
                  no calls recorded this process
                </div>
              ) : (
                planeHealth.recentCalls.slice(0, 12).map((c, i) => (
                  <div
                    key={`${c.time}-${c.path}-${i}`}
                    className="nt-mono-11 nt-text-sec"
                  >
                    {c.code} · {c.ms}ms · {c.path}
                  </div>
                ))
              )}
              {planeHealth.recentEvents.length > 0 ? (
                <>
                  <div className="nt-mono-11 nt-text-sec">
                    recent events ({planeHealth.recentEvents.length})
                  </div>
                  {planeHealth.recentEvents.slice(0, 8).map((e, i) => (
                    <div
                      key={`${e.time}-${i}`}
                      className="nt-hint-muted"
                    >
                      {e.what} · {e.who}
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
          <div className="nt-hint-muted nt-faint-10">
            snapshot {new Date(data.at).toLocaleString()} · pid {data.process.pid} · {data.process.platform}
            {' · '}
            showing {filteredPlanes.length}/{data.planes.length} planes
            {filter !== 'all' ? ` · filter ${filter}` : ''}
            {planeHealth ? ' · click a plane card for call drill-down' : ' · click a plane card for call drill-down'}
          </div>
        </div>
      ) : null}
    </div>
  );
}
