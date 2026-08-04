/**
 * Runtime debug panel — GET /api/debug/runtime.
 * Process/plane/poller facts only; no secrets or vendor payloads.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, SectionHeader, Spinner, useToast } from '../../nightdesk';
import { apiFetch, serverMessage } from '../../api/core';
import { exportTableCsv } from '../../lib/csv';

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

export function RuntimeDebugSection() {
  const { toast } = useToast();
  const [data, setData] = useState<RuntimeDebug | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [planeHealth, setPlaneHealth] = useState<PlaneHealth | null>(null);
  const [planeHealthError, setPlaneHealthError] = useState<string | null>(null);
  const [planeHealthLoading, setPlaneHealthLoading] = useState(false);
  const [healthDeep, setHealthDeep] = useState<HealthDeep | null>(null);
  const [healthDeepError, setHealthDeepError] = useState<string | null>(null);
  const [healthDeepLoading, setHealthDeepLoading] = useState(false);

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

  const loadPlaneHealth = async (planeId: string) => {
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
  };

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

  return (
    <div className="nt-stack nt-gap-12">
      <div className="nt-filter-bar nt-gap-10">
        <SectionHeader label="Runtime debug" meta="PROCESS · PLANES · NO SECRETS" />
        <Button variant="ghost" size="sm" onClick={() => { void load(); }} disabled={loading}>
          {loading ? <Spinner size="sm" /> : 'Refresh'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { void loadHealthDeep(); }} disabled={healthDeepLoading}>
          {healthDeepLoading ? <Spinner size="sm" /> : 'Health deep'}
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
                const n = exportTableCsv(
                  'runtime-planes.csv',
                  ['id', 'linked', 'health', 'stale', 'reason', 'ageSec', 'lastSync', 'noteChars'],
                  data.planes.map((p) => [
                    p.id,
                    p.linked,
                    p.health,
                    p.stale,
                    p.reason ?? '',
                    p.ageSec ?? '',
                    p.lastSync ?? '',
                    p.noteChars,
                  ]),
                );
                toast(`Exported ${n} plane row${n === 1 ? '' : 's'}`, {
                  description: 'runtime-planes.csv — link/health facts only, no secrets.',
                });
              }}
            >
              Export planes CSV
            </Button>
          </>
        ) : null}
      </div>

      {healthDeepError ? (
        <Alert tone="danger" title="Health deep unavailable">
          <span style={{ fontSize: 13 }}>{healthDeepError}</span>
        </Alert>
      ) : null}
      {healthDeep ? (
        <div
          className="nt-row nt-mono-11" style={{ color: "var(--nd-text-secondary)", flexDirection: 'column',
            gap: 4,
            padding: '8px 10px',
            background: 'var(--nd-bg-raised)',
            border: '1px solid var(--nd-border-subtle)',
            borderRadius: 4 }}
        >
          <span>
            GET /api/health?deep=1 · status {healthDeep.status} · up {fmtUptime(healthDeep.uptimeSec)} · auth{' '}
            {healthDeep.auth}
            {healthDeep.demoMode ? ' · demo' : ' · live'}
          </span>
          {healthDeep.deepWithheld ? (
            <span className="nt-hint-muted" style={{ color: "var(--nd-warning)" }}>
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
          <span style={{ fontSize: 13 }}>{error}</span>
        </Alert>
      ) : null}

      {loading && !data ? (
        <div className="nt-center-pad" style={{ padding: 16 }}>
          <Spinner size="sm" />
        </div>
      ) : null}

      {data ? (
        <div className="nt-stack nt-gap-10">
          <div className="nt-wrap-6 nt-gap-8" style={{ alignItems: "center" }}>
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

          <div className="nt-metrics-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
            {data.planes.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { void loadPlaneHealth(p.id); }}
                style={{
                  border: '1px solid var(--nd-border-subtle)',
                  borderRadius: 'var(--nd-radius-md)',
                  padding: '8px 10px',
                  background: 'var(--nd-bg-raised)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'inherit',
                  font: 'inherit',
                }}
              >
                <div className="nt-row-center nt-gap-6" style={{ marginBottom: 4 }}>
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
          {planeHealthLoading ? (
            <div className="nt-center-pad" style={{ padding: 8 }}>
              <Spinner size="sm" />
            </div>
          ) : null}
          {planeHealthError ? (
            <Alert tone="danger" title="Plane health unavailable">
              <span style={{ fontSize: 13 }}>{planeHealthError}</span>
            </Alert>
          ) : null}
          {planeHealth ? (
            <div
              style={{
                border: '1px solid var(--nd-border-subtle)',
                borderRadius: 'var(--nd-radius-md)',
                padding: '10px 12px',
                background: 'var(--nd-bg-raised)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div className="nt-wrap-6 nt-gap-8" style={{ alignItems: "center" }}>
                <span className="nt-mono-11" style={{ fontSize: 12 }}>{planeHealth.plane}</span>
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
          <div className="nt-hint-muted nt-hint-muted" style={{ fontSize: 10, color: "var(--nd-text-faint)" }}>
            snapshot {new Date(data.at).toLocaleString()} · pid {data.process.pid} · {data.process.platform}
            {planeHealth ? ' · click a plane card for call drill-down' : ' · click a plane card for call drill-down'}
          </div>
        </div>
      ) : null}
    </div>
  );
}
