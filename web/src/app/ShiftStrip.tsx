/**
 * Global shift strip — always-on trust chrome.
 * env · Live/Demo · P1s · degraded planes · freshness
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { hhmmLocal, relativeAge } from '@hpe/shared';
import { getOverview, getSystemsState } from '../api/client';
import { planePollDeltaAnnouncement } from './planePollDelta';
import { useSettings } from './SettingsContext';

type ShiftSnapshot = {
  env: string;
  mode: 'live' | 'demo' | 'unknown';
  p1Count: number;
  degraded: string[];
  syncedAt: string | null;
  backendMissing: boolean;
};

const EMPTY: ShiftSnapshot = {
  env: 'workspace',
  mode: 'unknown',
  p1Count: 0,
  degraded: [],
  syncedAt: null,
  backendMissing: false,
};

/** Human freshness label — relative age first, clock time as secondary title. */
export function shiftFreshnessLabel(
  syncedAt: string | null,
  backendMissing: boolean,
  nowMs: number = Date.now(),
): { label: string; title: string } {
  if (syncedAt) {
    const age = relativeAge(syncedAt, nowMs);
    const clock = hhmmLocal(syncedAt);
    if (age === '—') {
      return { label: `Fresh ${clock}`, title: `Newest successful sync ${clock}` };
    }
    return {
      label: `Fresh ${age} ago`,
      title: `Newest successful sync ${clock} (${age} ago)`,
    };
  }
  if (backendMissing) return { label: 'No backend', title: 'API unreachable' };
  return { label: 'Awaiting sync', title: 'No successful sync yet' };
}

/** Polite screen-reader summary — mode, P1 heat, planes, freshness. */
export function shiftStatusSummary(
  snap: Pick<ShiftSnapshot, 'mode' | 'p1Count' | 'degraded' | 'syncedAt' | 'backendMissing' | 'env'>,
  nowMs: number = Date.now(),
): string {
  const modeLabel = snap.mode === 'live' ? 'Live' : snap.mode === 'demo' ? 'Demo' : 'Offline';
  const p1 =
    snap.p1Count === 0
      ? 'no P1 alerts'
      : `${snap.p1Count} P1${snap.p1Count === 1 ? '' : 's'}`;
  const planes =
    snap.degraded.length === 0
      ? 'planes ok'
      : `${snap.degraded.length} plane${snap.degraded.length === 1 ? '' : 's'} degraded`;
  const fresh = shiftFreshnessLabel(snap.syncedAt, snap.backendMissing, nowMs).label;
  return `${snap.env}. ${modeLabel}. ${p1}. ${planes}. ${fresh}.`;
}

export function ShiftStrip() {
  const navigate = useNavigate();
  const { workspaceName } = useSettings();
  const [snap, setSnap] = useState<ShiftSnapshot>({ ...EMPTY, env: workspaceName });
  const [nowMs, setNowMs] = useState(() => Date.now());
  /* Plane poll delta — announce enter/leave only when the degraded set changes. */
  const [planeDelta, setPlaneDelta] = useState('');
  const prevDegradedRef = useRef<string[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const [systems, overview] = await Promise.all([getSystemsState(), getOverview()]);
      if (!live) return;

      const backendMissing = systems === null && overview.dataSource === 'demo';
      const demoMode = systems?.demoMode === true || overview.dataSource === 'demo';
      const planes = systems?.planes ? Object.values(systems.planes) : [];
      const degraded = planes
        .filter((p) => p.linked && (p.health === 'degraded' || p.health === 'warning' || p.stale))
        .map((p) => p.id);
      const p1Count = (overview.alerts ?? []).filter((a) => a.sev === 'P1').length;
      const syncedAt =
        systems?.syncedAt ??
        overview.syncedAt ??
        planes
          .map((p) => p.lastSync)
          .filter((t): t is string => Boolean(t))
          .sort()
          .at(-1) ??
        null;

      /* First snapshot seeds the baseline without announcing cold start noise. */
      if (prevDegradedRef.current === null) {
        prevDegradedRef.current = degraded;
      } else {
        const delta = planePollDeltaAnnouncement(prevDegradedRef.current, degraded);
        if (delta) {
          prevDegradedRef.current = degraded;
          setPlaneDelta(delta);
        } else {
          prevDegradedRef.current = degraded;
        }
      }

      setNowMs(Date.now());
      setSnap({
        env: workspaceName || overview.workspace || 'workspace',
        mode: backendMissing ? 'unknown' : demoMode ? 'demo' : 'live',
        p1Count,
        degraded,
        syncedAt,
        backendMissing,
      });
    };
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [workspaceName]);

  const modeLabel = snap.mode === 'live' ? 'Live' : snap.mode === 'demo' ? 'Demo' : 'Offline';
  const modeChip =
    snap.mode === 'live'
      ? 'nt-shift-strip__chip nt-shift-strip__chip--accent'
      : snap.mode === 'demo'
        ? 'nt-shift-strip__chip'
        : 'nt-shift-strip__chip nt-shift-strip__chip--warning';

  const p1Class =
    snap.p1Count > 0
      ? 'nt-shift-strip__chip nt-shift-strip__chip--danger nt-p1-heat'
      : 'nt-shift-strip__chip nt-shift-strip__chip--ok';

  const degClass =
    snap.degraded.length > 0
      ? 'nt-shift-strip__chip nt-shift-strip__chip--warning'
      : 'nt-shift-strip__chip nt-shift-strip__chip--ok';

  const fresh = useMemo(
    () => shiftFreshnessLabel(snap.syncedAt, snap.backendMissing, nowMs),
    [snap.syncedAt, snap.backendMissing, nowMs],
  );
  const liveSummary = useMemo(() => shiftStatusSummary(snap, nowMs), [snap, nowMs]);

  const hot = snap.p1Count > 0 || snap.degraded.length > 0 || snap.mode === 'unknown';

  return (
    <div
      className={`nt-shift-strip nd-shift-strip${hot ? ' nt-shift-strip--hot nd-shift-strip--hot' : ''}`}
      role="status"
      aria-label="Shift status"
      data-mode={snap.mode}
      data-p1={snap.p1Count > 0 ? '1' : '0'}
      data-degraded={snap.degraded.length > 0 ? '1' : '0'}
    >
      <span className="nt-shift-strip__brand nd-shift-strip__brand" aria-hidden>
        HPE Network Tools
      </span>
      <span className="nt-shift-strip__chip" title="Active workspace">
        <span className="nt-shift-strip__dot" aria-hidden />
        {snap.env}
      </span>

      <span className={modeChip} title="Data mode">
        <span
          className={`nt-shift-strip__dot${snap.mode === 'live' ? ' nt-shift-strip__dot--live' : ''}`}
          aria-hidden
        />
        {modeLabel}
      </span>

      <button
        type="button"
        className={p1Class}
        title="Open critical alerts"
        aria-label={`${snap.p1Count} P1${snap.p1Count === 1 ? '' : 's'}, open alerts`}
        onClick={() => navigate('/alerts?sev=P1')}
      >
        <span className="nt-shift-strip__dot" aria-hidden />
        {snap.p1Count} P1{snap.p1Count === 1 ? '' : 's'}
      </button>

      <button
        type="button"
        className={degClass}
        title={
          snap.degraded.length > 0
            ? `Degraded planes: ${snap.degraded.join(', ')}`
            : 'All linked planes healthy'
        }
        aria-label={
          snap.degraded.length > 0
            ? `${snap.degraded.length} plane${snap.degraded.length === 1 ? '' : 's'} degraded, open systems`
            : 'Planes ok, open systems'
        }
        onClick={() => navigate('/systems')}
      >
        <span className="nt-shift-strip__dot" aria-hidden />
        {snap.degraded.length > 0
          ? `${snap.degraded.length} plane${snap.degraded.length === 1 ? '' : 's'} degraded`
          : 'Planes ok'}
      </button>

      <span className="nt-shift-strip__spacer" aria-hidden />

      <span
        className={`nt-shift-strip__meta nt-shift-strip__fresh${
          snap.backendMissing || snap.mode === 'unknown'
            ? ' nt-freshness-stale'
            : snap.mode === 'demo'
              ? ' nt-freshness-stale'
              : ' nt-freshness-fresh'
        }`}
        title={fresh.title}
      >
        <span
          className="nt-sync-pulse"
          data-state={
            snap.backendMissing || snap.mode === 'unknown'
              ? 'down'
              : snap.mode === 'demo'
                ? 'stale'
                : 'live'
          }
          aria-hidden
        />
        {fresh.label}
      </span>

      {/* Polite live region: announces mode/P1/plane/freshness without focus steal. */}
      <span className="nt-sr-only" aria-live="polite" aria-atomic="true">
        {liveSummary}
      </span>
      {/* Separate polite region for plane poll enter/leave — only updates on set change. */}
      <span className="nt-sr-only" aria-live="polite" aria-atomic="true" data-testid="plane-poll-delta">
        {planeDelta}
      </span>
    </div>
  );
}
