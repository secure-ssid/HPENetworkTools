import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DiagnosticAuditEntry,
  DiagnosticEligibleDevice,
  DiagnosticJob,
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
  Spinner,
} from '../nightdesk';

const TERMINAL = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

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

  const [device, setDevice] = useState<DiagnosticEligibleDevice | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState('');
  const [sourceInterface, setSourceInterface] = useState('');
  const [vrfName, setVrfName] = useState('');
  const [useIpv6, setUseIpv6] = useState(false);
  const [useManagementInterface, setUseManagementInterface] = useState(false);
  const [review, setReview] = useState<DiagnosticReview | null>(null);
  const [job, setJob] = useState<DiagnosticJob | null>(null);
  const [history, setHistory] = useState<DiagnosticAuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Identity change (or first mount): clear every device-scoped bit of state
  // immediately — review, job, selected inputs, errors — before the fresh
  // eligibility/history read lands. Nothing carried over from a previous
  // device is ever shown against this one, even for a tick.
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setDevice(null);
    setHistory([]);
    setReview(null);
    setJob(null);
    setTarget('');
    setSourceInterface('');
    setVrfName('');
    setUseIpv6(false);
    setUseManagementInterface(false);
    setBusy(false);
    setError(null);
    setLoading(true);

    Promise.all([getDiagnosticEligibility(), getDiagnosticHistory()])
      .then(([eligibility, entries]) => {
        if (!isCurrent(generation)) return;
        setDevice(findEligibleDevice(eligibility.devices, plane, serial, deviceName));
        setHistory(entries.filter((entry) => matchesIdentity(entry, plane, serial, deviceName)).slice(0, 5));
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
  useEffect(() => {
    if (!job || TERMINAL.has(job.state)) return;
    let live = true;
    let polling = false;
    let failureCount = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const jobId = job.id;
    const startedAtMs = Date.now();

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
        setJob(next);
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
        const elapsed = Date.now() - startedAtMs;
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
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [job?.id, job?.state]);

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
      setJob(started);
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
      setJob(cancelled);
    } catch (err) {
      if (!isCurrent(generation)) return;
      setError((err as Error).message);
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  };

  if (loading) return <Spinner size="sm" />;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Alert tone="info" title="Reviewed operational action">
        Traceroute runs through New Central after explicit review. It is an operational action, not a configuration mutation.
        Portal cancellation stops operator polling only because Central exposes no documented traceroute cancel operation.
        Reservation/status tracking is in memory and is not recovered after a portal restart.
      </Alert>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone="accent">{device.deviceClass === 'ap' ? 'AP' : 'AOS-CX'}</Badge>
        <span style={{ fontSize: 12, color: 'var(--nd-text-secondary)' }}>{device.reason}</span>
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
            <div style={{ border: '1px solid var(--nd-border)', padding: 12, borderRadius: 8 }}>
              <div style={{ fontWeight: 650, marginBottom: 8 }}>Operator review</div>
              <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                Device: <Code>{review.device}</Code><br />
                Operation: <Code>traceroute</Code><br />
                Target: <Code>{review.target}</Code><br />
                Start: <Code>{review.startPath}</Code><br />
                Poll: <Code>{review.pollPathTemplate}</Code>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
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
        <div style={{ borderTop: '1px solid var(--nd-border-subtle)', paddingTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={job.state === 'succeeded' ? 'success' : job.state === 'failed' || job.state === 'timed_out' ? 'danger' : 'info'}>
              {job.state.replace('_', ' ')}
            </Badge>
            <span style={{ fontSize: 12 }}>{job.progressPercent}% · {job.message}</span>
          </div>
          {job.result?.hops.map((hop) => (
            <div key={hop.hop} style={{ display: 'flex', gap: 12, padding: '6px 0', fontFamily: 'var(--nd-font-mono)', fontSize: 11 }}>
              <span style={{ width: 24 }}>{hop.hop}</span>
              <span>{hop.probes.map((probe) => probe.reverseDnsResolution ?? probe.ipAddress ?? '*').join(' · ') || '*'}</span>
            </div>
          ))}
          {!TERMINAL.has(job.state) ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>Cancel portal polling</Button>
          ) : null}
        </div>
      ) : null}

      {error ? <Alert tone="danger" title="Diagnostic not started or updated">{error}</Alert> : null}

      {history.length ? (
        <div>
          <div style={{ fontSize: 11, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '.08em' }}>Recent audit history</div>
          {history.map((entry) => (
            <div key={`${entry.id}-${entry.at}`} style={{ fontSize: 11, paddingTop: 5, color: 'var(--nd-text-secondary)' }}>
              {new Date(entry.at).toLocaleString()} · <Code>{entry.plane}/{entry.serial}</Code> · {entry.state} · target {entry.target}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
