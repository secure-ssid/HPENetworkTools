import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DiagnosticAuditEntry,
  DiagnosticEligibleDevice,
  DiagnosticJob,
  DiagnosticProbe,
  DiagnosticReview,
  DiagnosticTracerouteOptions,
  Plane,
} from '@hpe/shared';
import {
  DiagnosticJobStatusError,
  cancelDiagnostic,
  getDiagnosticEligibility,
  getDiagnosticHistory,
  getDiagnosticJob,
  reviewDiagnostic,
  startDiagnostic,
} from '../api/client';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  FormField,
  Input,
  Skeleton,
  useToast,
} from '../nightdesk';
import { downloadApiCsv } from '../lib/downloadApiCsv';

const TERMINAL = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

/**
 * The distinct routers that answered a hop, in the order they first did.
 *
 * A hop is probed several times. Three replies from one router is one
 * address, not the same string printed three times; two different addresses
 * is a load-balanced path, which traceroute(8) also prints and which is worth
 * seeing. Probes that did not reply contribute no address — their silence is
 * carried by the time column, where it belongs.
 */
function hopAddresses(probes: DiagnosticProbe[]): string {
  const seen: string[] = [];
  for (const probe of probes) {
    const name = probe.reverseDnsResolution;
    const ip = probe.ipAddress;
    if (name === null && ip === null) continue;
    const text = name !== null && ip !== null ? `${name} (${ip})` : (name ?? ip ?? '');
    if (!seen.includes(text)) seen.push(text);
  }
  return seen.join(', ') || '*';
}

/**
 * One probe's round trip.
 *
 * `*` is no reply at all. `—` is a reply the plane put no time on, which is a
 * different fact and must not be drawn as a timeout — the hop is reachable,
 * we just were not told how far. The unit is appended only when the plane did
 * not already word it, since this arrives as free text.
 */
function probeTime(probe: DiagnosticProbe): string {
  const ms = probe.responseTimeMilliseconds;
  if (ms !== null && ms.trim() !== '') return /[a-z]/i.test(ms) ? ms : `${ms} ms`;
  return probe.ipAddress !== null || probe.reverseDnsResolution !== null ? '—' : '*';
}

// Job-status polling cadence. Once a job is running the panel polls at a
// steady 1s cadence (matching the pre-existing behaviour); on a transient
// fetch failure it backs off exponentially instead of hammering the portal.
const JOB_POLL_INITIAL_DELAY_MS = 500;
const JOB_POLL_STEADY_DELAY_MS = 1_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 8_000; // mirrors the server's own poll backoff ceiling
// The server gives up on a job after its own ~90s deadline (POLL_TIMEOUT_MS
// in server/src/services/diagnostics.ts) and answers with a terminal state.
// Retrying transient client-side failures well beyond that would just
// contradict a terminal answer the server would already have reached, so cap
// retries at the same order of magnitude plus headroom for one more round trip.
const RETRY_MAX_ELAPSED_MS = 100_000;

/**
 * How long this job has had to reach a terminal state, for the purpose of the
 * ceiling above.
 *
 * The ceiling is documented as "the plane's own job deadline", and the
 * server's deadline runs from when the job STARTED. Measuring only from when
 * this effect mounted made the two agree by accident: the poll effect is keyed
 * on the job's state, so a `starting` → `running` transition restarted the
 * clock, and re-opening the panel over a job already past its server deadline
 * restarted it again. The panel would then keep retrying status checks — and
 * keep saying "retrying" — long after the server had already answered
 * `timed_out`, which is exactly the contradiction the ceiling exists to avoid.
 *
 * `startedAt` is the server's clock and `now` is the browser's, so the two can
 * disagree. Taking whichever elapsed reading is LARGER means skew can only
 * make the panel stop retrying sooner, never later, and stopping sooner is the
 * safe error: it leaves the last known state on screen and says the status
 * CHECKS failed. It never claims anything about the diagnostic itself.
 */
export function retryElapsedMs(startedAt: string, watchedSinceMs: number, now: number): number {
  const sinceWatching = now - watchedSinceMs;
  const startedAtMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) return sinceWatching;
  const sinceStarted = now - startedAtMs;
  return sinceStarted > sinceWatching ? sinceStarted : sinceWatching;
}

/** A span in the vocabulary the rest of the portal ages rows in. */
function spanText(ms: number): string {
  if (ms < 1_000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

/**
 * How long the run has been going, or took.
 *
 * A job sitting at '45% · Running traceroute' for eight seconds and one that
 * has sat there for eight minutes are different facts about the estate, and
 * the panel drew them identically — `startedAt` and `finishedAt` were on the
 * wire and never read. A terminal state that carries no `finishedAt` gets an
 * age rather than a duration: the run's end is not known, so no length may be
 * claimed for it.
 */
export function jobDurationText(job: DiagnosticJob, now: number): string | null {
  const startedAtMs = new Date(job.startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) return null;
  if (job.finishedAt !== null) {
    const finishedAtMs = new Date(job.finishedAt).getTime();
    if (Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs) {
      return `took ${spanText(finishedAtMs - startedAtMs)}`;
    }
  }
  const age = now - startedAtMs;
  if (age < 0) return null;
  return TERMINAL.has(job.state) ? `started ${spanText(age)} ago` : `running ${spanText(age)}`;
}

/** The run's timing and Central's handle for it, as one muted line. */
export function jobTiming(job: DiagnosticJob, now: number): string {
  return [
    jobDurationText(job, now),
    job.taskId !== null ? `task ${job.taskId}` : null,
    job.taskId === null && job.state === 'cancelled'
      ? 'New Central returned no task id, so this run cannot be looked up there'
      : null,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' \u00b7 ');
}

/** Stable device identity for state-keying and race protection: plane+serial
 *  when the plane reports a serial (the only thing the reviewed-diagnostics
 *  API can address), a name-qualified fallback otherwise. Never just the
 *  display name — two devices can share one, and a rename must not orphan a
 *  live review/job for the same physical device. */
function identityOf(plane: Plane, serial: string | null, deviceName: string): string {
  return serial ? `${plane}::serial:${serial}` : `${plane}::name:${deviceName}`;
}

function findEligibleDevice(
  devices: DiagnosticEligibleDevice[],
  plane: Plane,
  serial: string | null,
  deviceName: string,
): DiagnosticEligibleDevice | null {
  if (serial) {
    return devices.find((row) => row.plane === plane && row.serial === serial) ?? null;
  }
  return devices.find((row) => row.plane === plane && row.name === deviceName) ?? null;
}

/** Same plane+serial (falling back to plane+name only when the device has no
 *  serial) match used everywhere else in this panel — a display name alone
 *  is never enough to tell two devices' audit trails apart. */
function matchesIdentity(
  entry: DiagnosticAuditEntry,
  plane: Plane,
  serial: string | null,
  deviceName: string,
): boolean {
  if (serial) return entry.plane === plane && entry.serial === serial;
  return entry.plane === plane && entry.device === deviceName;
}

export interface DiagnosticsPanelProps {
  deviceName: string;
  /** Live-inventory plane this device was read from. */
  plane: Plane;
  /** Live-inventory serial, when the plane reports one. Required to review
   *  or start a diagnostic — a device without one is never eligible. */
  serial: string | null;
}

export function DiagnosticsPanel({ deviceName, plane, serial }: DiagnosticsPanelProps) {
  const identity = useMemo(() => identityOf(plane, serial, deviceName), [plane, serial, deviceName]);
  const { toast } = useToast();

  const [device, setDevice] = useState<DiagnosticEligibleDevice | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState('');
  const [sourceInterface, setSourceInterface] = useState('');
  const [vrfName, setVrfName] = useState('');
  const [useIpv6, setUseIpv6] = useState(false);
  const [useManagementInterface, setUseManagementInterface] = useState(false);
  const [review, setReview] = useState<DiagnosticReview | null>(null);
  const [job, setJob] = useState<DiagnosticJob | null>(null);
  // The clock the run's age is drawn against. Polling stops at a terminal
  // state, so a ticking age would otherwise freeze mid-run whenever the
  // status endpoint went quiet, and read as a job that had stopped.
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** The only writer for `job`: every job the panel adopts re-stamps the
   *  clock its age is measured against, so a terminal state that arrives
   *  after the ticker has stopped is still aged from the right instant.
   *  Clearing the job on an identity switch is the render-phase reset below,
   *  which deliberately does NOT restamp — see it for why. */
  const adoptJob = (next: DiagnosticJob) => {
    setJob(next);
    setNowMs(Date.now());
  };
  const [history, setHistory] = useState<DiagnosticAuditEntry[]>([]);
  // Holes in the audit log itself, not in this device's runs. Kept apart from
  // `history` because they survive the identity filter below: a generation
  // that was deleted or would not open cannot be searched for this device, so
  // it is exactly the rows we cannot rule out that are missing.
  const [historyGaps, setHistoryGaps] = useState<{ discarded: number; unreadable: number }>(
    { discarded: 0, unreadable: 0 },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Identity change: clear every device-scoped bit of state — review, job,
  // selected inputs, errors — during render, before the new identity is ever
  // committed. Nothing carried over from a previous device is shown against
  // this one, even for a tick. This is React's adjust-state-during-render
  // pattern: these setStates re-render this component immediately, ahead of
  // the commit, so the reset lands before paint rather than in an effect
  // after it (where it is also a synchronous-setState cascading render).
  const [previousIdentity, setPreviousIdentity] = useState(identity);
  if (previousIdentity !== identity) {
    setPreviousIdentity(identity);
    setDevice(null);
    setHistory([]);
    setReview(null);
    // Not adoptJob(null): restamping the age clock would read Date.now()
    // during render, and the stamp is unobservable here anyway — the age is
    // only ever drawn for a live job, and adopting one restamps the clock.
    setJob(null);
    setTarget('');
    setSourceInterface('');
    setVrfName('');
    setUseIpv6(false);
    setUseManagementInterface(false);
    setBusy(false);
    setError(null);
    setHistoryGaps({ discarded: 0, unreadable: 0 });
    setLoading(true);
  }

  // Bumped every time the device identity changes (checked against a mounted
  // flag too), so any in-flight request started for a previous device can
  // recognise it is stale and drop its result instead of confirming/rendering
  // it against the device now on screen.
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  // Setup must restore mountedRef to true, not just leave it at its initial
  // value — under React.StrictMode every effect is mounted, cleaned up, and
  // re-mounted once synchronously to surface missing cleanup. Without
  // resetting it here, that simulated cleanup would leave mountedRef false
  // forever, so every later isCurrent() check fails, eligibility/history
  // never resolve, and the panel is stuck spinning under StrictMode.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const isCurrent = (generation: number) => mountedRef.current && generationRef.current === generation;

  // Bumped on every target/options edit so an in-flight or already-received
  // review can be told apart from what is now actually on screen — an input
  // edit must invalidate a review even though the device identity (and so
  // `generation`) hasn't changed at all.
  const formVersionRef = useRef(0);
  const reviewFormVersionRef = useRef<number | null>(null);

  // Identity change (or first mount): start the fresh eligibility/history
  // read. The generation bump retires any request still in flight for the
  // previous device; the state reset itself already happened during render,
  // above.
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;

    Promise.all([getDiagnosticEligibility(), getDiagnosticHistory()])
      .then(([eligibility, read]) => {
        if (!isCurrent(generation)) return;
        setDevice(findEligibleDevice(eligibility.devices, plane, serial, deviceName));
        setHistory(read.entries.filter((entry) => matchesIdentity(entry, plane, serial, deviceName)).slice(0, 5));
        setHistoryGaps({ discarded: read.discarded.length, unreadable: read.unreadable.length });
      })
      .catch((err: Error) => {
        if (!isCurrent(generation)) return;
        setError(err.message);
      })
      .finally(() => {
        if (!isCurrent(generation)) return;
        setLoading(false);
      });
    // identity folds plane+serial+deviceName into one key; listing them all
    // keeps the dependency array honest about what the effect actually reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // Job-status polling: bounded exponential backoff on transient failures
  // (network error, 5xx — retry), an honest stop on an answered terminal
  // failure (401/403 auth, 404 job gone — no amount of retrying fixes that),
  // and a client-side ceiling consistent with the server's own job deadline.
  //
  // The effect reads exactly these three scalars off the job: it re-keys on
  // the job's identity and state transitions, and `startedAt` feeds the
  // retry ceiling (see retryElapsedMs). Depending on the whole `job` object
  // would re-key the effect on every poll response — each adopted job is a
  // fresh object — restarting the poll cadence and the age ticker every time.
  const jobId = job?.id ?? null;
  const jobState = job?.state ?? null;
  const jobStartedAt = job?.startedAt ?? null;
  useEffect(() => {
    if (jobId === null || jobState === null || jobStartedAt === null || TERMINAL.has(jobState)) return;
    let live = true;
    let polling = false;
    let failureCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const watchedSinceMs = Date.now();
    // Captured once: the effect is re-keyed on the job's state, and the
    // ceiling must survive that (see retryElapsedMs).
    const watchedStartedAt = jobStartedAt;

    const schedule = (delay: number) => {
      if (!live) return;
      timer = setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (!live || polling) return; // never run two polls for this job at once
      polling = true;
      try {
        const next = await getDiagnosticJob(jobId);
        if (!live) return;
        failureCount = 0;
        adoptJob(next);
        setError(null);
        if (!TERMINAL.has(next.state)) schedule(JOB_POLL_STEADY_DELAY_MS);
      } catch (err) {
        if (!live) return;
        const status = err instanceof DiagnosticJobStatusError ? err.status : null;
        if (status === 401 || status === 403) {
          setError('Session is no longer authenticated — sign in again to keep checking this diagnostic.');
          return;
        }
        if (status === 404) {
          setError('This diagnostic job could not be found anymore — it may have expired or been cleared.');
          return;
        }
        failureCount += 1;
        const elapsed = retryElapsedMs(watchedStartedAt, watchedSinceMs, Date.now());
        const message = err instanceof Error ? err.message : String(err);
        if (elapsed >= RETRY_MAX_ELAPSED_MS) {
          setError(`Diagnostic status checks kept failing (${message}); giving up after the plane's own job deadline.`);
          return;
        }
        setError(`Diagnostic status check failed, retrying: ${message}`);
        schedule(Math.min(RETRY_BASE_DELAY_MS * 2 ** (failureCount - 1), RETRY_MAX_DELAY_MS));
      } finally {
        polling = false;
      }
    };

    schedule(JOB_POLL_INITIAL_DELAY_MS);
    // The run's age ticks on its own clock rather than on the poll's. A status
    // check that stalls must not also freeze the age beside it — a run stuck
    // at '45% · running 8s' reads as one that stopped, which is the opposite
    // of what a stalled poll over a live job means.
    const tick = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => {
      live = false;
      clearInterval(tick);
      if (timer) clearTimeout(timer);
    };
  }, [jobId, jobState, jobStartedAt]);

  const options = useMemo<DiagnosticTracerouteOptions>(() => {
    if (device?.deviceClass === 'ap') {
      return sourceInterface.trim() ? { sourceInterface: sourceInterface.trim() } : {};
    }
    return {
      ...(useIpv6 ? { useIpv6: true } : {}),
      ...(useManagementInterface ? { useManagementInterface: true } : {}),
      ...(vrfName.trim() ? { vrfName: vrfName.trim() } : {}),
    };
  }, [device?.deviceClass, sourceInterface, useIpv6, useManagementInterface, vrfName]);

  const resetReview = () => {
    setReview(null);
    setError(null);
  };

  // Any target/options edit invalidates whatever review is on screen (or
  // in flight) immediately — a review/confirmation must always describe
  // exactly the inputs currently visible, never what they used to be.
  const invalidateReview = () => {
    formVersionRef.current += 1;
    resetReview();
  };

  const requestReview = async () => {
    if (!device?.serial) return;
    const generation = generationRef.current;
    const formVersion = formVersionRef.current;
    setBusy(true);
    setError(null);
    try {
      const result = await reviewDiagnostic({
        plane,
        serial: device.serial,
        operation: 'traceroute',
        target,
        options,
      });
      // Device changed mid-flight, or the operator edited target/options
      // while the review was in flight — either way this response no
      // longer describes what's on screen and must never be shown.
      if (!isCurrent(generation) || formVersion !== formVersionRef.current) return;
      reviewFormVersionRef.current = formVersion;
      setReview(result);
    } catch (err) {
      if (!isCurrent(generation) || formVersion !== formVersionRef.current) return;
      setError((err as Error).message);
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  };

  const confirmStart = async () => {
    if (!review) return;
    // Defence in depth: the review should already have been cleared by
    // invalidateReview() the instant an input changed, but never confirm a
    // review whose snapshotted inputs no longer match the visible form.
    if (reviewFormVersionRef.current !== formVersionRef.current) {
      setReview(null);
      setError('Inputs changed since this review was issued — request a new review.');
      return;
    }
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    try {
      const started = await startDiagnostic(review.reviewId, review.plane, review.serial);
      if (!isCurrent(generation)) return; // never confirm a review for a device we've left
      adoptJob(started);
      setReview(null);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setError((err as Error).message);
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    const generation = generationRef.current;
    setBusy(true);
    try {
      const cancelled = await cancelDiagnostic(job.id);
      if (!isCurrent(generation)) return;
      adoptJob(cancelled);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setError((err as Error).message);
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="nt-debug-wake" aria-busy="true" aria-live="polite">
        <span className="nt-chat-pending__pulse" aria-hidden />
        <div className="nt-stack nt-gap-8 nt-flex-1">
          <Skeleton height={12} width="40%" />
          <Skeleton height={28} width="72%" />
          <Skeleton height={72} />
        </div>
        <span className="nt-hint-muted nt-chat-pending__label">NightDesk · diagnostics wake…</span>
      </div>
    );
  }
  if (!device) {
    return <Alert tone="warning" title="Not in live inventory">Active diagnostics are discovered from live inventory only.</Alert>;
  }
  if (!device.eligible) {
    return (
      <Alert tone="neutral" title="Active diagnostics disabled">
        {device.reason} No shell fallback or guessed operation will be used.
      </Alert>
    );
  }

  return (
    <div className="nt-diag nt-diagnostics-shell nt-diag-panel nt-section-panel">
      <div className="nt-plane-theater" role="note">NightDesk · diagnostics · honest probes</div>
      <Alert tone="info" title="Reviewed operational action">
        Traceroute runs through New Central after explicit review. It is an operational action, not a configuration mutation.
        Portal cancellation stops operator polling only because Central exposes no documented traceroute cancel operation.
        Reservation/status tracking is in memory and is not recovered after a portal restart.
      </Alert>

      <div className="nt-diag__row">
        <Badge tone="accent">{device.deviceClass === 'ap' ? 'AP' : 'AOS-CX'}</Badge>
        <span className="nt-diag__reason">{device.reason}</span>
      </div>

      {!job || TERMINAL.has(job.state) ? (
        <>
          <FormField label="Traceroute target" help="IP address or DNS hostname only. URLs, paths and credentials are rejected.">
            <Input
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                invalidateReview();
              }}
              placeholder="example.net or 192.0.2.10"
              mono
            />
          </FormField>
          {device.deviceClass === 'ap' ? (
            <FormField label="Source interface (optional)" help="Documented AP TracerouteApRequest field.">
              <Input
                value={sourceInterface}
                onChange={(event) => {
                  setSourceInterface(event.target.value);
                  invalidateReview();
                }}
                placeholder="eth0"
                mono
              />
            </FormField>
          ) : (
            <>
              <FormField label="VRF name (optional)" help="Documented CX TracerouteCxRequest field; Central defaults to default.">
                <Input
                  value={vrfName}
                  onChange={(event) => {
                    setVrfName(event.target.value);
                    invalidateReview();
                  }}
                  placeholder="default"
                  mono
                />
              </FormField>
              <Checkbox
                checked={useIpv6}
                onChange={(event) => {
                  setUseIpv6(event.target.checked);
                  invalidateReview();
                }}
                label="Use IPv6"
              />
              <Checkbox
                checked={useManagementInterface}
                onChange={(event) => {
                  setUseManagementInterface(event.target.checked);
                  invalidateReview();
                }}
                label="Use management interface"
              />
            </>
          )}

          {review ? (
            <div className="nt-diag__review">
              <div className="nt-diag__review-title">Operator review</div>
              <div className="nt-diag__review-body">
                Device: <Code>{review.device}</Code><br />
                Operation: <Code>traceroute</Code><br />
                Target: <Code>{review.target}</Code><br />
                Start: <Code>{review.startPath}</Code><br />
                Poll: <Code>{review.pollPathTemplate}</Code>
              </div>
              <div className="nt-diag__review-actions">
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void confirmStart()}>
                  {busy ? 'Starting…' : 'Confirm and run traceroute'}
                </Button>
                <Button variant="ghost" size="sm" onClick={resetReview}>Edit</Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" size="sm" disabled={busy || !target.trim()} onClick={() => void requestReview()}>
              {busy ? 'Validating…' : 'Review traceroute'}
            </Button>
          )}
        </>
      ) : null}

      {job ? (
        <div className="nt-diag__job">
          <div className="nt-diag__job-head">
            <Badge tone={job.state === 'succeeded' ? 'success' : job.state === 'failed' || job.state === 'timed_out' ? 'danger' : 'info'}>
              {job.state.replace('_', ' ')}
            </Badge>
            <span className="nt-diag__job-msg">{job.progressPercent}% · {job.message}</span>
          </div>
          {/* How long, and Central's own handle for the run. `cancelled` means
              the PORTAL stopped watching and the upstream task kept going, so
              that is the state in which an operator most needs an identifier
              to chase it with — and the one state where its absence has to be
              said out loud rather than left as a blank. */}
          {jobTiming(job, nowMs) ? (
            <div className="nt-diag__mono nt-diag__mono--pad6">
              {jobTiming(job, nowMs)}
            </div>
          ) : null}
          {/* What the run was actually aimed at. `resolvedIp` is the answer to
              "am I even tracing to the host I meant?" — a stale DNS record
              sends a perfect-looking trace to the wrong address. */}
          {job.result && (job.result.destination !== null || job.result.resolvedIp !== null) ? (
            <div className="nt-diag__mono nt-diag__mono--pad8">
              to {job.result.destination ?? 'the requested target'}
              {job.result.resolvedIp !== null ? ` (${job.result.resolvedIp})` : ''}
            </div>
          ) : null}
          {/* Hops are keyed by position: an unresponsive hop normalises to '*'
              server-side, and a firewall that drops TTL-exceeded produces a
              run of them that would otherwise share one React key. */}
          {job.result?.hops.map((hop, index) => (
            <div key={`${index}-${hop.hop}`} className="nt-diag__hop">
              <span className="nt-diag__hop-n">{hop.hop}</span>
              <span className="nt-diag__hop-addr">{hopAddresses(hop.probes)}</span>
              <span className="nt-diag__hop-rtt">
                {hop.probes.map(probeTime).join(' · ') || '*'}
              </span>
            </div>
          ))}
          {!TERMINAL.has(job.state) ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>Cancel portal polling</Button>
          ) : null}
        </div>
      ) : null}

      {error ? <Alert tone="danger" title="Diagnostic not started or updated">{error}</Alert> : null}

      {/* Deliberately outside the `history.length` gate. The dangerous case is
          an empty list beside a log with a hole in it: no rows then reads as
          "this device has never been diagnosed", when the runs that would say
          otherwise are in a generation retention deleted or one that will not
          open. The wording stays at "may not be listed" because that is the
          honest limit of what we know — the deleted entries cannot be
          searched for this device. */}
      {historyGaps.discarded > 0 || historyGaps.unreadable > 0 ? (
        <Alert tone="warning" title="Audit history is incomplete">
          {historyGaps.discarded > 0
            ? `${historyGaps.discarded} older ${historyGaps.discarded === 1 ? 'stretch' : 'stretches'} of history ${historyGaps.discarded === 1 ? 'was' : 'were'} discarded by the retention policy. `
            : ''}
          {historyGaps.unreadable > 0
            ? `${historyGaps.unreadable} rotated ${historyGaps.unreadable === 1 ? 'generation' : 'generations'} could not be read. `
            : ''}
          Earlier diagnostics for this device may not be listed{history.length ? '' : ' — including any that would have appeared here'}.
        </Alert>
      ) : null}

      {history.length || historyGaps.discarded > 0 || historyGaps.unreadable > 0 ? (
        <div className="nt-filter-bar nt-gap-8">
          <Button
            variant="ghost"
            size="sm"
            className="nt-ml-auto"
            onClick={() => {
              void (async () => {
                const params = new URLSearchParams();
                if (serial) params.set('device', serial);
                else if (deviceName) params.set('device', deviceName);
                if (plane) params.set('plane', plane);
                const qs = params.toString();
                const res = await downloadApiCsv(
                  `/api/diagnostics/history/export${qs ? `?${qs}` : ''}`,
                  'diagnostics-history.csv',
                );
                if (res.ok) {
                  toast('Server CSV downloaded', {
                    description:
                      'diagnostics-history.csv — audit rows only; target always redacted.',
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
        </div>
      ) : null}

      {history.length ? (
        <div>
          <div className="nt-diag__audit-label">Recent audit history</div>
          {history.map((entry) => (
            <div key={`${entry.id}-${entry.at}`} className="nt-diag__audit-row">
              {new Date(entry.at).toLocaleString()} · <Code>{entry.plane}/{entry.serial}</Code> · {entry.state} · target {entry.target}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
