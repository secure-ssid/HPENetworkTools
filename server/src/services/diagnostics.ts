/**
 * Reviewed New Central active diagnostics.
 *
 * Authoritative API reference (verified 2026-07-29):
 * - initiateApTracerouteV1 / getApTracerouteResultV1
 *   https://developer.arubanetworks.com/new-central/reference/getaptracerouteresultv1
 * - initiateCxTracerouteV1 / getCxTracerouteResultV1
 *   https://developer.arubanetworks.com/new-central/reference/initiatecxtraceroutev1
 *
 * Exact paths:
 * POST /network-troubleshooting/v1/{aps|cx}/{serial}/traceroute
 * GET  /network-troubleshooting/v1/{aps|cx}/{serial}/traceroute/async-operations/{task-id}
 *
 * This is an operational action, not a configuration mutation. A POST cannot
 * happen until the server has issued a short-lived reviewId and the operator
 * sends that id back with confirmed:true. Only allow-listed fields are written
 * to diagnostics-history.jsonl; targets are always redacted and upstream
 * bodies/rawOutput are never logged or returned.
 *
 * New Central documents initiation and result polling, but no traceroute
 * cancellation operation. "Cancel" therefore stops operator-facing polling
 * only: the process-local plane+serial/global reservation remains until a
 * background observation sees a terminal state or the original deadline.
 * A transport failure after an initiation POST is equally ambiguous: the job
 * is reported failed with an unknown outcome, while its reservation remains
 * until that same deadline so a retry cannot duplicate an accepted task.
 * HTTP 202 without a usable task identifier is accepted but untrackable: it
 * follows the same reservation rule without issuing any status poll.
 * Reservations and timers are intentionally in memory; a portal restart loses
 * them (including ambiguous initiation reservations) because the documented
 * API provides no task-list/recovery operation.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DeviceRow,
  DiagnosticAuditEntry,
  DiagnosticDeviceClass,
  DiagnosticEligibleDevice,
  DiagnosticEligibilityResponse,
  DiagnosticHop,
  DiagnosticJob,
  DiagnosticJobState,
  DiagnosticResult,
  DiagnosticReview,
  DiagnosticReviewRequest,
  DiagnosticTracerouteOptions,
  Plane,
} from '../../../shared';
import { CentralAdapter, CentralRequestError } from '../planes/central';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { poller } from './poller';
import { brokerDataDir, type BrokerResponse, type BrokerTransport } from './writeBroker';

const REVIEW_TTL_MS = 10 * 60_000;
const POLL_INITIAL_MS = 1_000;
const POLL_MAX_MS = 8_000;
const POLL_TIMEOUT_MS = 90_000;
const CANCELLED_POLL_MS = 15_000;
const MAX_HISTORY = 100;
const MAX_JOBS = 100;
const MAX_PENDING_REVIEWS = 100;
const MAX_ACTIVE_JOBS = 10;
const PLANES = new Set<Plane>([
  'CENTRAL',
  'CLASSIC',
  'MIST',
  'GREENLAKE',
  'AOS-8',
  'AOS-10',
  'LOCAL',
  'CLEARPASS',
  'UXI',
  'SSE',
  'THIRD-PARTY',
]);

interface StoredReview {
  review: DiagnosticReview;
  requestBody: Record<string, unknown>;
}

interface InternalJob {
  public: DiagnosticJob;
  pollPath: string;
  deadlineMs: number;
  nextDelayMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** True until the upstream task is terminal or the original deadline. */
  reservationActive: boolean;
  /** Operator-facing polling was cancelled; the upstream task was not. */
  operatorCancelled: boolean;
  /** The initiation POST lost its response, so acceptance cannot be known. */
  initiationUnknown: boolean;
  /** Central accepted the POST, but supplied no safe task identifier to poll. */
  acceptedUntrackable: boolean;
  /** Portal status polling failed without proving the upstream task terminal. */
  pollingUncertain: boolean;
  startPending: boolean;
}

export class DiagnosticsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DiagnosticsError';
  }
}

export interface DiagnosticsServiceOptions {
  registry?: PlaneRegistry;
  transport?: BrokerTransport | null;
  liveDevices?: () => DeviceRow[];
  dataDir?: string;
  nowMs?: () => number;
  schedule?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  pollTimeoutMs?: number;
  pollInitialMs?: number;
  pollMaxMs?: number;
  cancelledPollMs?: number;
  maxPendingReviews?: number;
  maxActiveJobs?: number;
  maxJobs?: number;
}

function text(value: unknown, max = 256): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function strictText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

const NULL_TEXT_SENTINELS = new Set([
  'null',
  '(null)',
  '<null>',
  'nil',
  'none',
  'undefined',
  'n/a',
  'na',
  'not available',
  'not reported',
  'unknown',
  '-',
  '--',
  '*',
]);

function validTaskId(value: unknown): string | null {
  const taskId = strictText(value, 128);
  return taskId &&
    /^[A-Za-z0-9-]+$/.test(taskId) &&
    !NULL_TEXT_SENTINELS.has(taskId.toLowerCase())
    ? taskId
    : null;
}

function taskIdFromLocation(value: unknown, prefix: string): string | null {
  const location = strictText(value, 2048);
  if (!location) return null;
  try {
    const parsed = new URL(location, 'https://central.invalid');
    if (parsed.search || parsed.hash || !parsed.pathname.startsWith(prefix)) return null;
    return validTaskId(parsed.pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

function acceptedTaskId(
  response: BrokerResponse,
  body: Record<string, unknown>,
  prefix: string,
): string | null {
  const candidates = [
    taskIdFromLocation(response.location, prefix),
    taskIdFromLocation(body.location, prefix),
    validTaskId(body.taskId),
    validTaskId(body.task_id),
    validTaskId(body['task-id']),
  ].filter((candidate): candidate is string => candidate !== null);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

/** New Central schemas permit nullable hop fields, and some responses encode
 * the same absence as a string sentinel instead of JSON null. */
function nullableDiagnosticText(value: unknown, max: number): string | null {
  const normalized = text(value, max);
  return normalized && !NULL_TEXT_SENTINELS.has(normalized.toLowerCase())
    ? normalized
    : null;
}

function planeValue(value: unknown): Plane | null {
  const plane = text(value, 32);
  return plane && PLANES.has(plane as Plane) ? plane as Plane : null;
}

function targetValue(raw: unknown): string {
  const target = text(raw, 253);
  if (!target) throw new DiagnosticsError(400, 'traceroute target is required');
  if (net.isIP(target)) return target;
  if (
    target.includes('://') ||
    target.includes('@') ||
    target.includes('/') ||
    target.endsWith('.') ||
    !target.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  ) {
    throw new DiagnosticsError(400, 'target must be an IP address or DNS hostname, without a scheme, path, or credentials');
  }
  return target.toLowerCase();
}

function optionText(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = text(raw, 64);
  if (!value || !/^[A-Za-z0-9_.:/-]+$/.test(value)) {
    throw new DiagnosticsError(400, `${field} contains unsupported characters`);
  }
  return value;
}

function optionsFor(deviceClass: DiagnosticDeviceClass, raw: unknown): DiagnosticTracerouteOptions {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const known = new Set(['sourceInterface', 'useIpv6', 'useManagementInterface', 'vrfName']);
  const unknown = Object.keys(source).filter((key) => !known.has(key));
  if (unknown.length) throw new DiagnosticsError(400, `unsupported traceroute option '${unknown[0]}'`);

  if (deviceClass === 'ap') {
    if (source.useIpv6 !== undefined || source.useManagementInterface !== undefined || source.vrfName !== undefined) {
      throw new DiagnosticsError(400, 'CX traceroute options cannot be used with an AP');
    }
    const sourceInterface = optionText(source.sourceInterface, 'sourceInterface');
    return sourceInterface ? { sourceInterface } : {};
  }

  if (source.sourceInterface !== undefined) {
    throw new DiagnosticsError(400, 'sourceInterface is an AP-only traceroute option');
  }
  for (const key of ['useIpv6', 'useManagementInterface'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean') {
      throw new DiagnosticsError(400, `${key} must be boolean`);
    }
  }
  const vrfName = optionText(source.vrfName, 'vrfName');
  return {
    ...(typeof source.useIpv6 === 'boolean' ? { useIpv6: source.useIpv6 } : {}),
    ...(typeof source.useManagementInterface === 'boolean'
      ? { useManagementInterface: source.useManagementInterface }
      : {}),
    ...(vrfName ? { vrfName } : {}),
  };
}

function cxModel(model: string): boolean {
  return /(?:^|[\s-])(?:AOS-)?CX(?:[\s-]|$)/i.test(model);
}

function safeProgress(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : 0;
}

function safeResult(
  body: Record<string, unknown>,
  identity: Pick<DiagnosticJob, 'device' | 'serial' | 'plane'>,
): DiagnosticResult {
  const output = body.output;
  const record = output && typeof output === 'object'
    ? output as Record<string, unknown>
    : {};
  const hops: DiagnosticHop[] = Array.isArray(record.hops)
    ? record.hops.slice(0, 64).flatMap((rawHop) => {
        if (!rawHop || typeof rawHop !== 'object') return [];
        const hop = rawHop as Record<string, unknown>;
        const probes = Array.isArray(hop.probes)
          ? hop.probes.slice(0, 8).flatMap((rawProbe) => {
              if (!rawProbe || typeof rawProbe !== 'object') return [];
              const probe = rawProbe as Record<string, unknown>;
              return [{
                ipAddress: nullableDiagnosticText(probe.ipAddress, 128),
                reverseDnsResolution: nullableDiagnosticText(probe.reverseDnsResolution, 253),
                responseTimeMilliseconds: nullableDiagnosticText(probe.responseTimeMilliseconds, 64),
              }];
            })
          : [];
        return [{ hop: nullableDiagnosticText(hop.hop, 16) ?? '*', probes }];
      })
    : [];
  return {
    ...identity,
    destination: nullableDiagnosticText(record.destination, 253),
    resolvedIp: nullableDiagnosticText(record.resolvedIp, 128),
    hops,
  };
}

export class DiagnosticsService {
  private readonly registry: PlaneRegistry;
  private readonly transportOverride: BrokerTransport | null | undefined;
  private readonly liveDevices: () => DeviceRow[];
  private readonly dataDir: string;
  private readonly nowMs: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearSchedule: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly pollTimeoutMs: number;
  private readonly pollInitialMs: number;
  private readonly pollMaxMs: number;
  private readonly cancelledPollMs: number;
  private readonly maxPendingReviews: number;
  private readonly maxActiveJobs: number;
  private readonly maxJobs: number;
  private readonly reviews = new Map<string, StoredReview>();
  private readonly jobs = new Map<string, InternalJob>();

  constructor(opts: DiagnosticsServiceOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.transportOverride = opts.transport;
    this.liveDevices = opts.liveDevices ?? (() => poller.getCache().devices);
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.clearSchedule = opts.clearSchedule ?? ((timer) => clearTimeout(timer));
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    this.pollInitialMs = opts.pollInitialMs ?? POLL_INITIAL_MS;
    this.pollMaxMs = opts.pollMaxMs ?? POLL_MAX_MS;
    this.cancelledPollMs = opts.cancelledPollMs ?? CANCELLED_POLL_MS;
    this.maxPendingReviews = opts.maxPendingReviews ?? MAX_PENDING_REVIEWS;
    this.maxActiveJobs = opts.maxActiveJobs ?? MAX_ACTIVE_JOBS;
    this.maxJobs = opts.maxJobs ?? MAX_JOBS;
  }

  eligibility(): DiagnosticEligibilityResponse {
    return {
      operation: 'traceroute',
      source: 'live-inventory',
      devices: this.liveDevices().map((device) => this.eligibilityFor(device)),
    };
  }

  review(raw: DiagnosticReviewRequest | Record<string, unknown>): DiagnosticReview {
    this.pruneReviews();
    if (this.reviews.size >= this.maxPendingReviews) {
      throw new DiagnosticsError(429, 'too many pending diagnostic reviews; confirm or wait for an existing review to expire');
    }
    if (raw.operation !== 'traceroute') {
      throw new DiagnosticsError(400, "only the documented 'traceroute' operation is supported");
    }
    const plane = planeValue(raw.plane);
    const serial = text(raw.serial, 128);
    if (!plane) throw new DiagnosticsError(400, 'plane is required');
    if (!serial) throw new DiagnosticsError(400, 'serial is required');
    const device = this.inventoryDevice(plane, serial);
    const eligible = this.eligibilityFor(device);
    if (!eligible.eligible || !eligible.deviceClass) {
      throw new DiagnosticsError(409, eligible.reason);
    }
    const target = targetValue(raw.target);
    const options = optionsFor(eligible.deviceClass, raw.options);
    const segment = eligible.deviceClass === 'ap' ? 'aps' : 'cx';
    const encodedSerial = encodeURIComponent(serial);
    const startPath = `/network-troubleshooting/v1/${segment}/${encodedSerial}/traceroute`;
    const reviewId = randomUUID();
    const review: DiagnosticReview = {
      reviewId,
      expiresAt: new Date(this.nowMs() + REVIEW_TTL_MS).toISOString(),
      device: device.name,
      serial,
      plane,
      deviceClass: eligible.deviceClass,
      operation: 'traceroute',
      target,
      options,
      startPath,
      pollPathTemplate: `${startPath}/async-operations/{task-id}`,
      warning: 'Traceroute is an operational action on the device. It does not mutate configuration.',
    };
    this.reviews.set(reviewId, {
      review,
      requestBody: { destination: target, ...options, includeRawOutput: false },
    });
    this.audit({
      id: reviewId,
      at: new Date(this.nowMs()).toISOString(),
      device: device.name,
      serial,
      plane,
      operation: 'traceroute',
      state: 'reviewed',
      target: '[redacted]',
    });
    return review;
  }

  async start(
    reviewIdRaw: unknown,
    confirmed: unknown,
    planeRaw?: unknown,
    serialRaw?: unknown,
  ): Promise<DiagnosticJob> {
    const reviewId = text(reviewIdRaw);
    if (!reviewId) throw new DiagnosticsError(400, 'reviewId is required');
    if (confirmed !== true) {
      throw new DiagnosticsError(400, 'explicit confirmation is required before an active diagnostic can start');
    }
    const plane = planeValue(planeRaw);
    const serial = text(serialRaw, 128);
    if (!plane) throw new DiagnosticsError(400, 'plane is required');
    if (!serial) throw new DiagnosticsError(400, 'serial is required');
    this.pruneReviews();
    this.pruneJobs();
    const stored = this.reviews.get(reviewId);
    if (!stored) throw new DiagnosticsError(409, 'review is missing, expired, or already used — review the diagnostic again');
    this.reviews.delete(reviewId);
    if (plane !== stored.review.plane || serial !== stored.review.serial) {
      throw new DiagnosticsError(409, 'confirmed device identity does not match the reviewed diagnostic');
    }
    const current = this.inventoryDevice(plane, serial, true);
    const currentEligibility = current ? this.eligibilityFor(current) : null;
    if (
      !current ||
      current.name !== stored.review.device ||
      !currentEligibility?.eligible ||
      currentEligibility.deviceClass !== stored.review.deviceClass
    ) {
      throw new DiagnosticsError(409, 'device inventory changed after review; review the diagnostic again');
    }
    const transport = this.centralTransport();
    if (!transport) throw new DiagnosticsError(409, 'New Central is not linked for active diagnostics');
    const active = [...this.jobs.values()].filter((candidate) => this.isActive(candidate));
    const existing = active.find((candidate) =>
      candidate.public.plane === plane && candidate.public.serial === serial);
    if (existing?.acceptedUntrackable) {
      throw new DiagnosticsError(
        409,
        `New Central already accepted an untrackable diagnostic for this device. Its final outcome is unknown; do not retry before ${new Date(existing.deadlineMs).toISOString()}. Check New Central directly if immediate confirmation is required.`,
      );
    }
    if (existing) {
      throw new DiagnosticsError(409, 'an active diagnostic already exists for this device');
    }
    if (active.length >= this.maxActiveJobs) {
      if (active.some((candidate) => candidate.acceptedUntrackable)) {
        throw new DiagnosticsError(429, 'the global active diagnostic job limit is reserved by at least one Central-accepted task that cannot be tracked; wait for its original deadline before retrying');
      }
      throw new DiagnosticsError(429, 'the global active diagnostic job limit has been reached');
    }

    const now = this.nowMs();
    const jobId = randomUUID();
    const job: InternalJob = {
      public: {
        id: jobId,
        device: stored.review.device,
        serial,
        plane,
        deviceClass: stored.review.deviceClass,
        operation: 'traceroute',
        state: 'starting',
        taskId: null,
        progressPercent: 0,
        startedAt: new Date(now).toISOString(),
        finishedAt: null,
        message: 'Starting traceroute in New Central…',
        result: null,
      },
      pollPath: '',
      deadlineMs: now + this.pollTimeoutMs,
      nextDelayMs: this.pollInitialMs,
      timer: null,
      reservationActive: true,
      operatorCancelled: false,
      initiationUnknown: false,
      acceptedUntrackable: false,
      pollingUncertain: false,
      startPending: true,
    };
    this.jobs.set(jobId, job);
    this.pruneJobs();

    let response: BrokerResponse;
    try {
      response = await transport.request('POST', stored.review.startPath, stored.requestBody);
    } catch (err) {
      job.startPending = false;
      if (!job.reservationActive) return this.copy(job.public);
      if (err instanceof CentralRequestError && err.kind === 'authentication') {
        this.finish(job, 'failed', 'New Central authentication failed; traceroute was not started');
        if (job.operatorCancelled) return this.copy(job.public);
        throw new DiagnosticsError(401, job.public.message);
      }
      if (err instanceof CentralRequestError && err.kind === 'service') {
        this.finish(job, 'failed', 'New Central authentication service was unavailable; traceroute was not started');
        if (job.operatorCancelled) return this.copy(job.public);
        throw new DiagnosticsError(502, job.public.message);
      }
      this.markInitiationUnknown(job);
      if (job.operatorCancelled) return this.copy(job.public);
      throw new DiagnosticsError(502, job.public.message);
    }
    job.startPending = false;
    if (!job.reservationActive) return this.copy(job.public);
    if (response.status !== 202) {
      this.finish(job, 'failed', this.httpMessage(response.status, 'start'), response.status);
      if (job.operatorCancelled) return this.copy(job.public);
      throw new DiagnosticsError(this.startResponseStatus(response.status), job.public.message);
    }

    const body = response.body && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : {};
    const prefix = `${stored.review.startPath}/async-operations/`;
    const taskId = acceptedTaskId(response, body, prefix);
    if (!taskId) {
      this.markAcceptedUntrackable(job);
      if (job.operatorCancelled) return this.copy(job.public);
      throw new DiagnosticsError(502, job.public.message);
    }
    job.public.taskId = taskId;
    job.pollPath = `${prefix}${encodeURIComponent(taskId)}`;
    if (job.operatorCancelled) {
      this.scheduleNext(job);
    } else {
      job.public.state = 'running';
      job.public.message = 'Traceroute is running in New Central';
      this.schedulePoll(job, 0);
    }
    return this.copy(job.public);
  }

  status(idRaw: unknown): DiagnosticJob {
    const id = text(idRaw);
    const job = id ? this.jobs.get(id) : null;
    if (!job) throw new DiagnosticsError(404, 'diagnostic job not found');
    return this.copy(job.public);
  }

  cancel(idRaw: unknown): DiagnosticJob {
    const id = text(idRaw);
    const job = id ? this.jobs.get(id) : null;
    if (!job) throw new DiagnosticsError(404, 'diagnostic job not found');
    if (job.reservationActive && !job.operatorCancelled) {
      job.operatorCancelled = true;
      if (job.timer) {
        this.clearSchedule(job.timer);
        job.timer = null;
      }
      job.public.state = 'cancelled';
      job.public.finishedAt = new Date(this.nowMs()).toISOString();
      job.public.message = 'Portal polling cancelled; New Central was not cancelled. Capacity remains reserved until Central finishes or the original deadline.';
      this.audit({
        id: job.public.id,
        at: job.public.finishedAt,
        device: job.public.device,
        serial: job.public.serial,
        plane: job.public.plane,
        operation: 'traceroute',
        state: 'cancelled',
        target: '[redacted]',
      });
      if (job.startPending) this.scheduleReservationDeadline(job);
      else if (job.pollPath) this.scheduleNext(job);
      else this.scheduleReservationDeadline(job);
    }
    return this.copy(job.public);
  }

  history(): DiagnosticAuditEntry[] {
    try {
      const file = path.join(this.dataDir, 'diagnostics-history.jsonl');
      return fs.readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-MAX_HISTORY)
        .reverse()
        .flatMap((line) => {
          try {
            const raw = JSON.parse(line) as Record<string, unknown>;
            const id = text(raw.id, 128);
            const at = text(raw.at, 64);
            const device = text(raw.device, 256);
            const serial = text(raw.serial, 128);
            const plane = planeValue(raw.plane);
            const operation = raw.operation === 'traceroute' ? 'traceroute' : null;
            const state = typeof raw.state === 'string' &&
              [
                'reviewed',
                'starting',
                'running',
                'succeeded',
                'failed',
                'timed_out',
                'cancelled',
                'initiation_unknown',
                'accepted_untrackable',
                'reservation_expired',
              ].includes(raw.state)
              ? raw.state as DiagnosticAuditEntry['state']
              : null;
            if (!id || !at || !device || !serial || !plane || !operation || !state) return [];
            return [{
              id,
              at,
              device,
              serial,
              plane,
              operation,
              state,
              target: '[redacted]' as const,
              ...(typeof raw.httpCode === 'number' ? { httpCode: raw.httpCode } : {}),
            }];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  private eligibilityFor(device: DeviceRow): DiagnosticEligibleDevice {
    let deviceClass: DiagnosticDeviceClass | null = null;
    let reason = 'Eligible for reviewed New Central traceroute';
    if (device.plane === 'CLASSIC') {
      reason = 'Classic Central is read-only here; active diagnostics require New Central';
    } else if (device.plane !== 'CENTRAL') {
      reason = `${device.plane} devices are read-only here; no active diagnostic path is implemented`;
    } else if (!this.registry.state('central').capabilities?.activeDiagnostics) {
      reason = 'The linked Central adapter is not a New Central gateway; active diagnostics are disabled';
    } else if (!device.serial) {
      reason = 'No serial is present in live inventory, so the API cannot address this device';
    } else if (/down|offline/i.test(device.state)) {
      reason = 'The live inventory reports this device offline';
    } else if (device.type === 'ap') {
      deviceClass = 'ap';
    } else if (device.type === 'switch' && cxModel(device.model)) {
      deviceClass = 'cx';
    } else if (device.type === 'switch') {
      reason = 'The inventory does not identify this switch as AOS-CX; no path will be guessed';
    } else {
      reason = `Device type '${device.type}' has no verified traceroute operation in this portal`;
    }
    return {
      name: device.name,
      serial: device.serial ?? null,
      plane: device.plane,
      type: device.type,
      model: device.model,
      deviceClass,
      eligible: deviceClass !== null,
      reason,
    };
  }

  private centralTransport(): BrokerTransport | null {
    if (this.transportOverride !== undefined) return this.transportOverride;
    const adapter = this.registry.get('central');
    return adapter instanceof CentralAdapter && adapter.capabilities().activeDiagnostics ? adapter : null;
  }

  private schedulePoll(job: InternalJob, delayMs: number): void {
    if (!job.reservationActive || !job.pollPath) return;
    if (job.timer) this.clearSchedule(job.timer);
    job.timer = this.schedule(() => {
      job.timer = null;
      void this.poll(job);
    }, delayMs);
  }

  private async poll(job: InternalJob): Promise<void> {
    if (!job.reservationActive) return;
    if (this.nowMs() >= job.deadlineMs) {
      this.finish(job, 'timed_out', 'Traceroute reservation reached its original safety deadline');
      return;
    }
    const transport = this.centralTransport();
    if (!transport) {
      if (job.operatorCancelled) {
        this.scheduleNext(job);
      } else {
        this.markPollingUncertain(job, 'New Central became unavailable while polling traceroute status');
      }
      return;
    }
    let response: BrokerResponse;
    try {
      response = await transport.request('GET', job.pollPath);
    } catch (err) {
      if (!job.reservationActive) return;
      if (job.operatorCancelled) {
        this.scheduleNext(job);
        return;
      }
      if (err instanceof CentralRequestError && err.kind === 'authentication') {
        this.markPollingUncertain(
          job,
          'New Central authentication failed while polling; traceroute status cannot continue',
        );
        return;
      }
      if (job.reservationActive) {
        job.public.message = err instanceof CentralRequestError && err.kind === 'service'
          ? 'New Central authentication service is unavailable; retrying with bounded backoff'
          : 'New Central status transport failed; retrying with bounded backoff';
        this.scheduleNext(job);
      }
      return;
    }
    if (!job.reservationActive) return;
    if (response.status === 429) {
      if (!job.operatorCancelled) {
        job.public.message = 'New Central rate-limited status polling; backing off safely';
      }
      this.scheduleNext(job, this.rateLimitDelayMs(response));
      return;
    }
    if (response.status !== 200) {
      if (job.operatorCancelled) {
        // An observation failure is not an upstream terminal state.
        this.scheduleNext(job);
      } else {
        this.markPollingUncertain(job, this.httpMessage(response.status, 'poll'), response.status);
      }
      return;
    }
    const body = response.body && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : {};
    const upstreamState = text(body.status, 32)?.toUpperCase();
    if (!job.operatorCancelled && !job.pollingUncertain) {
      job.public.progressPercent = safeProgress(body.progressPercent);
    }
    if (upstreamState === 'INITIATED' || upstreamState === 'RUNNING') {
      if (!job.operatorCancelled && !job.pollingUncertain) {
        job.public.state = 'running';
        job.public.message = 'Traceroute is running in New Central';
      }
      this.scheduleNext(job);
      return;
    }
    if (upstreamState === 'FAILED' || text(body.failReason, 256)) {
      this.finish(job, 'failed', 'New Central reported traceroute failure');
      return;
    }
    if (upstreamState === 'COMPLETED') {
      if (!job.operatorCancelled && !job.pollingUncertain) {
        job.public.result = safeResult(body, job.public);
        job.public.progressPercent = 100;
      }
      this.finish(job, 'succeeded', 'Traceroute completed');
      return;
    }
    if (job.operatorCancelled) {
      this.scheduleNext(job);
    } else {
      this.markPollingUncertain(job, 'New Central returned an unrecognised traceroute status');
    }
  }

  private scheduleNext(job: InternalJob, minimumDelayMs = 0): void {
    if (!job.reservationActive) return;
    const remainingMs = job.deadlineMs - this.nowMs();
    if (remainingMs <= 0) {
      this.finish(job, 'timed_out', 'Traceroute reservation reached its original safety deadline');
      return;
    }
    const desiredDelay = job.operatorCancelled || job.pollingUncertain
      ? Math.max(this.cancelledPollMs, minimumDelayMs)
      : Math.max(this.pollInitialMs, job.nextDelayMs, minimumDelayMs);
    const delay = Math.min(desiredDelay, remainingMs);
    job.nextDelayMs = Math.min(this.pollMaxMs, Math.max(this.pollInitialMs, job.nextDelayMs * 2));
    this.schedulePoll(job, delay);
  }

  private finish(job: InternalJob, state: DiagnosticJobState, message: string, httpCode?: number): void {
    if (!job.reservationActive) return;
    if (job.timer) {
      this.clearSchedule(job.timer);
      job.timer = null;
    }
    job.reservationActive = false;
    job.startPending = false;
    const finishedAt = new Date(this.nowMs()).toISOString();
    if (!job.operatorCancelled && !job.pollingUncertain) {
      job.public.state = state;
      job.public.message = message;
      job.public.finishedAt = finishedAt;
    }
    this.audit({
      id: job.public.id,
      at: finishedAt,
      device: job.public.device,
      serial: job.public.serial,
      plane: job.public.plane,
      operation: 'traceroute',
      state,
      target: '[redacted]',
      ...(httpCode !== undefined ? { httpCode } : {}),
    });
  }

  private markInitiationUnknown(job: InternalJob): void {
    if (!job.reservationActive || job.initiationUnknown) return;
    job.initiationUnknown = true;
    const at = new Date(this.nowMs()).toISOString();
    if (!job.operatorCancelled) {
      job.public.state = 'failed';
      job.public.finishedAt = at;
      job.public.message = 'New Central did not answer the traceroute initiation; its outcome is unknown. Capacity remains reserved until the original deadline to prevent a duplicate request.';
    }
    this.audit({
      id: job.public.id,
      at,
      device: job.public.device,
      serial: job.public.serial,
      plane: job.public.plane,
      operation: 'traceroute',
      state: 'initiation_unknown',
      target: '[redacted]',
    });
    this.scheduleReservationDeadline(job);
  }

  private markAcceptedUntrackable(job: InternalJob): void {
    if (!job.reservationActive || job.acceptedUntrackable) return;
    job.acceptedUntrackable = true;
    const at = new Date(this.nowMs()).toISOString();
    if (!job.operatorCancelled) {
      job.public.state = 'failed';
      job.public.finishedAt = at;
      job.public.message = `New Central accepted the traceroute, but returned no usable task ID. Its final outcome is unknown and it cannot be polled here. Do not retry before ${new Date(job.deadlineMs).toISOString()}; check New Central directly if immediate confirmation is required.`;
    }
    this.audit({
      id: job.public.id,
      at,
      device: job.public.device,
      serial: job.public.serial,
      plane: job.public.plane,
      operation: 'traceroute',
      state: 'accepted_untrackable',
      target: '[redacted]',
      httpCode: 202,
    });
    this.scheduleReservationDeadline(job);
  }

  private markPollingUncertain(job: InternalJob, message: string, httpCode?: number): void {
    if (!job.reservationActive) return;
    if (!job.pollingUncertain) {
      job.pollingUncertain = true;
      const at = new Date(this.nowMs()).toISOString();
      if (!job.operatorCancelled) {
        job.public.state = 'failed';
        job.public.finishedAt = at;
        job.public.message = `${message}. Capacity remains reserved until Central reports a terminal state or the original deadline.`;
      }
      this.audit({
        id: job.public.id,
        at,
        device: job.public.device,
        serial: job.public.serial,
        plane: job.public.plane,
        operation: 'traceroute',
        state: 'failed',
        target: '[redacted]',
        ...(httpCode !== undefined ? { httpCode } : {}),
      });
    }
    this.scheduleNext(job);
  }

  private expireReservation(job: InternalJob): void {
    if (!job.initiationUnknown && !job.acceptedUntrackable && !job.pollingUncertain) {
      this.finish(job, 'timed_out', 'Traceroute reservation reached its original safety deadline');
      return;
    }
    if (!job.reservationActive) return;
    if (job.timer) {
      this.clearSchedule(job.timer);
      job.timer = null;
    }
    job.reservationActive = false;
    job.startPending = false;
    this.audit({
      id: job.public.id,
      at: new Date(this.nowMs()).toISOString(),
      device: job.public.device,
      serial: job.public.serial,
      plane: job.public.plane,
      operation: 'traceroute',
      state: 'reservation_expired',
      target: '[redacted]',
    });
  }

  private scheduleReservationDeadline(job: InternalJob): void {
    if (!job.reservationActive) return;
    const remainingMs = job.deadlineMs - this.nowMs();
    if (remainingMs <= 0) {
      this.expireReservation(job);
      return;
    }
    if (job.timer) this.clearSchedule(job.timer);
    job.timer = this.schedule(() => {
      job.timer = null;
      this.expireReservation(job);
    }, remainingMs);
  }

  private httpMessage(status: number, phase: 'start' | 'poll'): string {
    if (status === 401) return 'New Central authentication failed; traceroute cannot continue';
    if (status === 403) return 'New Central denied the traceroute operation; credentials are not authorised';
    if (status === 429) return 'New Central rate-limited the traceroute request';
    if (status === 409) return 'New Central reports the device is offline or busy';
    return `New Central answered HTTP ${status} while trying to ${phase} traceroute`;
  }

  private startResponseStatus(status: number): number {
    if ([401, 403, 409, 429].includes(status)) return status;
    return 502;
  }

  private rateLimitDelayMs(response: BrokerResponse): number {
    const delays = [
      response.retryAfterMs,
      response.rateLimitResetAtMs === undefined
        ? undefined
        : response.rateLimitResetAtMs - this.nowMs(),
    ].filter((delay): delay is number => typeof delay === 'number' && Number.isFinite(delay));
    return Math.max(0, ...delays);
  }

  private inventoryDevice(plane: Plane, serial: string): DeviceRow;
  private inventoryDevice(plane: Plane, serial: string, allowMissing: true): DeviceRow | null;
  private inventoryDevice(plane: Plane, serial: string, allowMissing = false): DeviceRow | null {
    const matches = this.liveDevices().filter((device) =>
      device.plane === plane && device.serial === serial);
    if (matches.length > 1) {
      throw new DiagnosticsError(409, 'live inventory contains an ambiguous duplicate device identity');
    }
    if (matches.length === 0) {
      if (allowMissing) return null;
      throw new DiagnosticsError(404, 'the exact plane and serial are not in live inventory');
    }
    return matches[0];
  }

  private isActive(job: InternalJob): boolean {
    return job.reservationActive;
  }

  private audit(entry: DiagnosticAuditEntry): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const file = path.join(this.dataDir, 'diagnostics-history.jsonl');
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch {
      console.error('diagnostics: audit history write failed');
    }
  }

  private pruneReviews(): void {
    const now = this.nowMs();
    for (const [id, stored] of this.reviews) {
      if (Date.parse(stored.review.expiresAt) <= now) this.reviews.delete(id);
    }
  }

  private pruneJobs(): void {
    if (this.jobs.size <= this.maxJobs) return;
    for (const [id, job] of this.jobs) {
      if (!this.isActive(job)) this.jobs.delete(id);
      if (this.jobs.size <= this.maxJobs) break;
    }
  }

  private copy(job: DiagnosticJob): DiagnosticJob {
    return JSON.parse(JSON.stringify(job)) as DiagnosticJob;
  }
}

export const diagnosticsService = new DiagnosticsService();
