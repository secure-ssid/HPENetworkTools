/**
 * New Central traceroute tests.
 *
 * Operation/path assertions mirror initiateApTracerouteV1/
 * getApTracerouteResultV1 and initiateCxTracerouteV1/
 * getCxTracerouteResultV1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DeviceRow, DiagnosticReview } from '@hpe/shared';
import { SettingsStore } from '../src/config/settings';
import { CentralRequestError } from '../src/planes/central';
import { PlaneRegistry } from '../src/planes/registry';
import { DiagnosticsService } from '../src/services/diagnostics';
import type { BrokerResponse, BrokerTransport } from '../src/services/writeBroker';

const root = path.resolve(process.cwd(), '.diagnostics-test-data');
let registry: PlaneRegistry;

function device(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    name: 'ap-1',
    model: 'AP-635',
    type: 'ap',
    siteId: 'campus-01',
    siteName: 'Campus-01',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'up',
    stateTone: 'success',
    firmware: '10.7',
    firmwareApproved: true,
    licence: 'foundation',
    reconciliationIssue: false,
    localShell: false,
    serial: 'AP-SERIAL',
    ...overrides,
  };
}

function scheduler() {
  type Item = { fn: () => void; delay: number; cancelled: boolean };
  const queue: Item[] = [];
  const schedule = (fn: () => void, delay: number) => {
    const item: Item = { fn, delay, cancelled: false };
    queue.push(item);
    return item as unknown as ReturnType<typeof setTimeout>;
  };
  const clearSchedule = (timer: ReturnType<typeof setTimeout>) => {
    const item = timer as unknown as Item;
    item.cancelled = true;
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
  };
  const run = async (advance?: (ms: number) => void) => {
    const item = queue.shift();
    if (!item) throw new Error('no scheduled poll');
    advance?.(item.delay);
    if (!item.cancelled) item.fn();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { queue, schedule, clearSchedule, run };
}

function service(
  devices: DeviceRow[],
  transport: BrokerTransport,
  extra: ConstructorParameters<typeof DiagnosticsService>[0] = {},
) {
  return new DiagnosticsService({
    registry,
    transport,
    liveDevices: () => devices,
    dataDir: root,
    ...extra,
  });
}

function reviewed(
  svc: DiagnosticsService,
  serial = 'AP-SERIAL',
  target = 'example.net',
): DiagnosticReview {
  return svc.review({ plane: 'CENTRAL', serial, operation: 'traceroute', target });
}

function startReviewed(svc: DiagnosticsService, review: DiagnosticReview, confirmed = true) {
  return svc.start(review.reviewId, confirmed, review.plane, review.serial);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const store = new SettingsStore(path.join(root, 'settings.json'));
  store.load();
  store.update({
    planes: {
      central: {
        gatewayBaseUrl: 'https://internal.api.central.arubanetworks.com',
        clientId: 'client-id',
        clientSecret: 'secret',
      },
    },
  });
  registry = new PlaneRegistry(store);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DiagnosticsService inventory identity and review gate', () => {
  it('discovers AP/CX and disables Classic/unsupported types honestly', () => {
    const svc = service([
      device(),
      device({ name: 'cx-1', type: 'switch', model: 'Aruba CX 6300M', serial: 'CX-SERIAL' }),
      device({ name: 'classic-ap', plane: 'CLASSIC', serial: 'CLASSIC-SERIAL' }),
      device({ name: 'aos-s', type: 'switch', model: '2930F', serial: 'AOS-SERIAL' }),
      device({ name: 'gw-1', type: 'gateway', model: '9004', serial: 'GW-SERIAL' }),
    ], { request: async () => ({ status: 500, body: {} }) });
    const rows = svc.eligibility().devices;
    expect(rows.find((row) => row.serial === 'AP-SERIAL')).toMatchObject({ eligible: true, deviceClass: 'ap' });
    expect(rows.find((row) => row.serial === 'CX-SERIAL')).toMatchObject({ eligible: true, deviceClass: 'cx' });
    expect(rows.find((row) => row.serial === 'CLASSIC-SERIAL')?.reason).toContain('Classic Central');
    expect(rows.find((row) => row.serial === 'AOS-SERIAL')?.reason).toContain('no path will be guessed');
    expect(rows.find((row) => row.serial === 'GW-SERIAL')?.reason).toContain('no verified traceroute');
  });

  it('targets duplicate display names by exact plane and serial', async () => {
    const seen: string[] = [];
    const devices = [
      device({ name: 'duplicate', serial: 'SERIAL-A' }),
      device({ name: 'duplicate', serial: 'SERIAL-B' }),
    ];
    const svc = service(devices, {
      request: async (_method, requestPath) => {
        seen.push(requestPath);
        return { status: 202, body: { location: `${requestPath}/async-operations/task-b` } };
      },
    }, scheduler());
    const review = reviewed(svc, 'SERIAL-B');
    expect(review).toMatchObject({ device: 'duplicate', plane: 'CENTRAL', serial: 'SERIAL-B' });
    const job = await startReviewed(svc, review);
    expect(job).toMatchObject({ device: 'duplicate', plane: 'CENTRAL', serial: 'SERIAL-B' });
    expect(seen[0]).toContain('/SERIAL-B/');
  });

  it('rejects stale inventory and mismatched confirmation identities before POST', async () => {
    const devices = [device()];
    let posts = 0;
    const svc = service(devices, {
      request: async () => {
        posts += 1;
        return { status: 202, body: {} };
      },
    });
    const mismatch = reviewed(svc);
    await expect(svc.start(mismatch.reviewId, true, 'CENTRAL', 'OTHER-SERIAL'))
      .rejects.toMatchObject({ status: 409 });

    const stale = reviewed(svc);
    devices.splice(0, 1, device({ serial: 'REPLACEMENT-SERIAL' }));
    await expect(startReviewed(svc, stale)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('inventory changed'),
    });
    expect(posts).toBe(0);
  });

  it('rejects invalid input and bounds pending reviews', async () => {
    const svc = service([device()], { request: async () => ({ status: 500, body: {} }) }, {
      maxPendingReviews: 1,
    });
    expect(() => svc.review({
      plane: 'CENTRAL',
      serial: 'AP-SERIAL',
      operation: 'traceroute',
      target: 'https://example.net/x',
    })).toThrow(/IP address or DNS hostname/);
    expect(() => svc.review({
      plane: 'CENTRAL',
      serial: 'AP-SERIAL',
      operation: 'ping' as 'traceroute',
      target: 'example.net',
    })).toThrow(/only the documented 'traceroute'/);
    expect(() => svc.review({
      plane: 'CENTRAL',
      serial: 'AP-SERIAL',
      operation: 'traceroute',
      target: 'example.net',
      options: { vrfName: 'blue' },
    })).toThrow(/CX traceroute options/);
    const review = reviewed(svc);
    expect(() => reviewed(svc)).toThrow(/too many pending/);
    await expect(startReviewed(svc, review, false)).rejects.toMatchObject({ status: 400 });
  });
});

describe('DiagnosticsService documented paths and lifecycle', () => {
  it('uses exact AP/CX paths and documented request bodies', async () => {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    const transport: BrokerTransport = {
      request: async (method, requestPath, body) => {
        seen.push({ method, path: requestPath, body });
        return {
          status: 202,
          body: { location: `${requestPath}/async-operations/task-123`, status: 'INITIATED' },
        };
      },
    };
    const devices = [
      device(),
      device({ name: 'cx-1', type: 'switch', model: 'CX-6300M', serial: 'CX-SERIAL' }),
    ];
    const ap = service(devices, transport, scheduler());
    const apReview = ap.review({
      plane: 'CENTRAL',
      serial: 'AP-SERIAL',
      operation: 'traceroute',
      target: 'example.net',
      options: { sourceInterface: 'eth0' },
    });
    expect((await startReviewed(ap, apReview)).taskId).toBe('task-123');

    const cx = service(devices, transport, scheduler());
    const cxReview = cx.review({
      plane: 'CENTRAL',
      serial: 'CX-SERIAL',
      operation: 'traceroute',
      target: '2001:db8::1',
      options: { useIpv6: true, useManagementInterface: true, vrfName: 'blue' },
    });
    await startReviewed(cx, cxReview);
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/network-troubleshooting/v1/aps/AP-SERIAL/traceroute',
        body: { destination: 'example.net', sourceInterface: 'eth0', includeRawOutput: false },
      },
      {
        method: 'POST',
        path: '/network-troubleshooting/v1/cx/CX-SERIAL/traceroute',
        body: {
          destination: '2001:db8::1',
          useIpv6: true,
          useManagementInterface: true,
          vrfName: 'blue',
          includeRawOutput: false,
        },
      },
    ]);
  });

  it('polls to a structured identity-bearing result without raw output', async () => {
    const sched = scheduler();
    let calls = 0;
    const svc = service([device()], {
      request: async (method, requestPath) => {
        if (method === 'POST') return { status: 202, body: { location: `${requestPath}/async-operations/t1` } };
        calls += 1;
        if (calls === 1) {
          return { status: 200, body: { status: 'RUNNING', progressPercent: 40, rawOutput: 'secret raw' } };
        }
        return {
          status: 200,
          body: {
            status: 'COMPLETED',
            rawOutput: 'must not escape',
            output: {
              destination: 'example.net',
              resolvedIp: '192.0.2.1',
              hops: [{ hop: '1', probes: [{ reverseDnsResolution: 'router.example', responseTimeMilliseconds: '1.2 ms' }] }],
            },
          },
        };
      },
    }, sched);
    const started = await startReviewed(svc, reviewed(svc));
    await sched.run();
    expect(svc.status(started.id)).toMatchObject({ state: 'running', progressPercent: 40 });
    await sched.run();
    const done = svc.status(started.id);
    expect(done).toMatchObject({
      state: 'succeeded',
      device: 'ap-1',
      serial: 'AP-SERIAL',
      plane: 'CENTRAL',
      result: {
        device: 'ap-1',
        serial: 'AP-SERIAL',
        plane: 'CENTRAL',
      },
    });
    expect(done.result?.hops[0].probes[0].reverseDnsResolution).toBe('router.example');
    expect(JSON.stringify(done)).not.toContain('rawOutput');
    expect(JSON.stringify(done)).not.toContain('must not escape');
  });

  it('normalizes documented null-like hop sentinels to actual null values', async () => {
    const sched = scheduler();
    const svc = service([device()], {
      request: async (method, requestPath) => method === 'POST'
        ? { status: 202, body: { location: `${requestPath}/async-operations/null-hops` } }
        : {
            status: 200,
            body: {
              status: 'COMPLETED',
              output: {
                destination: 'NULL',
                resolvedIp: '',
                hops: [
                  {
                    hop: '1',
                    probes: [
                      { ipAddress: 'null', reverseDnsResolution: 'NULL', responseTimeMilliseconds: '' },
                      { ipAddress: '', reverseDnsResolution: 'n/a', responseTimeMilliseconds: 'none' },
                      { ipAddress: '192.0.2.1', reverseDnsResolution: 'router.example', responseTimeMilliseconds: '1.2 ms' },
                    ],
                  },
                  { hop: 'NULL', probes: [{ ipAddress: '*', reverseDnsResolution: 'not reported' }] },
                ],
              },
            },
          },
    }, sched);
    const job = await startReviewed(svc, reviewed(svc));
    await sched.run();
    const result = svc.status(job.id).result;
    expect(result).toMatchObject({
      destination: null,
      resolvedIp: null,
      hops: [
        {
          hop: '1',
          probes: [
            { ipAddress: null, reverseDnsResolution: null, responseTimeMilliseconds: null },
            { ipAddress: null, reverseDnsResolution: null, responseTimeMilliseconds: null },
            { ipAddress: '192.0.2.1', reverseDnsResolution: 'router.example', responseTimeMilliseconds: '1.2 ms' },
          ],
        },
        {
          hop: '*',
          probes: [{ ipAddress: null, reverseDnsResolution: null }],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/"null"|"NULL"/);
  });

  it('handles upstream diagnostic failure and cancellation', async () => {
    const sched = scheduler();
    const svc = service([device()], {
      request: async (method, requestPath) => method === 'POST'
        ? { status: 202, body: { location: `${requestPath}/async-operations/t2` } }
        : { status: 200, body: { status: 'FAILED', failReason: 'Destination not resolved' } },
    }, sched);
    const job = await startReviewed(svc, reviewed(svc, 'AP-SERIAL', 'bad.example'));
    await sched.run();
    expect(svc.status(job.id)).toMatchObject({
      state: 'failed',
      message: 'New Central reported traceroute failure',
    });

    const cancelSched = scheduler();
    const cancellable = service([device()], {
      request: async (method, requestPath) => method === 'POST'
        ? { status: 202, body: { location: `${requestPath}/async-operations/t3` } }
        : { status: 200, body: { status: 'COMPLETED', output: { hops: [] } } },
    }, cancelSched);
    const pending = await startReviewed(cancellable, reviewed(cancellable));
    expect(cancellable.cancel(pending.id)).toMatchObject({
      state: 'cancelled',
      message: expect.stringContaining('New Central was not cancelled'),
    });
    await cancelSched.run();
    expect(cancellable.status(pending.id).state).toBe('cancelled');
    expect(cancellable.history().entries.filter((entry) => entry.id === pending.id).map((entry) => entry.state))
      .toEqual(['succeeded', 'cancelled']);
  });
});

describe('DiagnosticsService limits and concurrent confirmations', () => {
  it('reserves one slot per device before POST under concurrent confirmations', async () => {
    const gate = deferred<BrokerResponse>();
    let posts = 0;
    const svc = service([device()], {
      request: async () => {
        posts += 1;
        return gate.promise;
      },
    }, { maxActiveJobs: 2 });
    const firstReview = reviewed(svc);
    const secondReview = reviewed(svc);
    const firstStart = startReviewed(svc, firstReview);
    await expect(startReviewed(svc, secondReview)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('already exists'),
    });
    expect(posts).toBe(1);
    gate.resolve({
      status: 202,
      body: { location: `${firstReview.startPath}/async-operations/race-1` },
    });
    const firstJob = await firstStart;
    svc.cancel(firstJob.id);
  });

  it('enforces the global cap and never prunes an active reservation', async () => {
    const devices = [
      device({ serial: 'SERIAL-A' }),
      device({ name: 'ap-2', serial: 'SERIAL-B' }),
      device({ name: 'ap-3', serial: 'SERIAL-C' }),
    ];
    const gate = deferred<BrokerResponse>();
    let posts = 0;
    const svc = service(devices, {
      request: async () => {
        posts += 1;
        return gate.promise;
      },
    }, { maxActiveJobs: 1, maxJobs: 0 });
    const firstReview = reviewed(svc, 'SERIAL-A');
    const firstStart = startReviewed(svc, firstReview);
    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({ status: 429 });
    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-C'))).rejects.toMatchObject({ status: 429 });
    expect(posts).toBe(1);
    gate.resolve({
      status: 202,
      body: { location: `${firstReview.startPath}/async-operations/global-1` },
    });
    const firstJob = await firstStart;
    svc.cancel(firstJob.id);
  });

  it('keeps a cancelled in-flight POST reserved through accepted-task completion', async () => {
    const devices = [
      device({ serial: 'SERIAL-A' }),
      device({ name: 'ap-2', serial: 'SERIAL-B' }),
    ];
    const sched = scheduler();
    const gate = deferred<BrokerResponse>();
    let firstPost = true;
    const svc = service(devices, {
      request: async (method, requestPath) => {
        if (method === 'GET') return { status: 200, body: { status: 'COMPLETED', output: { hops: [] } } };
        if (firstPost) {
          firstPost = false;
          return gate.promise;
        }
        return { status: 202, body: { location: `${requestPath}/async-operations/next-task` } };
      },
    }, { ...sched, maxActiveJobs: 1, cancelledPollMs: 1_000 });
    const firstReview = reviewed(svc, 'SERIAL-A');
    const firstStart = startReviewed(svc, firstReview);
    const starting = [...(svc as unknown as { jobs: Map<string, { public: { id: string } }> }).jobs.values()][0];
    expect(svc.cancel(starting.public.id).state).toBe('cancelled');
    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({ status: 429 });
    gate.resolve({
      status: 202,
      body: { location: `${firstReview.startPath}/async-operations/cancel-race` },
    });
    expect((await firstStart).state).toBe('cancelled');
    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({ status: 429 });
    await sched.run();
    expect((await startReviewed(svc, reviewed(svc, 'SERIAL-B'))).state).toBe('running');
  });

  it('expires a cancelled hanging POST reservation and ignores a late response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T17:00:00Z'));
    const devices = [
      device({ serial: 'SERIAL-A' }),
      device({ name: 'ap-2', serial: 'SERIAL-B' }),
    ];
    const gate = deferred<BrokerResponse>();
    let firstPost = true;
    const svc = service(devices, {
      request: async (method, requestPath) => {
        if (method === 'GET') return { status: 200, body: { status: 'COMPLETED', output: { hops: [] } } };
        if (firstPost) {
          firstPost = false;
          return gate.promise;
        }
        return { status: 202, body: { location: `${requestPath}/async-operations/replacement` } };
      },
    }, {
      maxActiveJobs: 1,
      pollTimeoutMs: 10_000,
      cancelledPollMs: 2_000,
    });
    const firstReview = reviewed(svc, 'SERIAL-A');
    const firstStart = startReviewed(svc, firstReview);
    const starting = [...(svc as unknown as { jobs: Map<string, { public: { id: string } }> }).jobs.values()][0];
    svc.cancel(starting.public.id);

    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(svc.history().entries.filter((entry) => entry.id === starting.public.id).map((entry) => entry.state))
      .toEqual(['timed_out', 'cancelled']);

    const replacement = await startReviewed(svc, reviewed(svc, 'SERIAL-B'));
    gate.resolve({
      status: 202,
      body: { location: `${firstReview.startPath}/async-operations/late-task` },
    });
    expect((await firstStart).state).toBe('cancelled');

    svc.cancel(replacement.id);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps same-device and global reservations after cancel until observed completion, then cleans up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T18:00:00Z'));
    const devices = [
      device({ serial: 'SERIAL-A' }),
      device({ name: 'ap-2', serial: 'SERIAL-B' }),
    ];
    const svc = service(devices, {
      request: async (method, requestPath) => method === 'POST'
        ? { status: 202, body: { location: `${requestPath}/async-operations/completes-after-cancel` } }
        : { status: 200, body: { status: 'COMPLETED', output: { hops: [] } } },
    }, {
      maxActiveJobs: 1,
      pollTimeoutMs: 20_000,
      pollInitialMs: 1_000,
      pollMaxMs: 1_000,
      cancelledPollMs: 5_000,
    });
    const first = await startReviewed(svc, reviewed(svc, 'SERIAL-A'));
    expect(svc.cancel(first.id).state).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(1);

    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-A'))).rejects.toMatchObject({ status: 409 });
    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(4_999);
    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-A'))).rejects.toMatchObject({ status: 409 });

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(svc.history().entries.filter((entry) => entry.id === first.id).map((entry) => entry.state))
      .toEqual(['succeeded', 'cancelled']);

    const second = await startReviewed(svc, reviewed(svc, 'SERIAL-B'));
    svc.cancel(second.id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds cancelled reservations to the original deadline and audits timeout separately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T19:00:00Z'));
    const svc = service([device()], {
      request: async (method, requestPath) => method === 'POST'
        ? { status: 202, body: { location: `${requestPath}/async-operations/runs-past-deadline` } }
        : { status: 200, body: { status: 'RUNNING', progressPercent: 50 } },
    }, {
      pollTimeoutMs: 10_000,
      pollInitialMs: 1_000,
      pollMaxMs: 1_000,
      cancelledPollMs: 3_000,
    });
    const first = await startReviewed(svc, reviewed(svc));
    svc.cancel(first.id);

    await vi.advanceTimersByTimeAsync(9_999);
    await expect(startReviewed(svc, reviewed(svc))).rejects.toMatchObject({ status: 409 });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(svc.status(first.id).state).toBe('cancelled');
    expect(svc.history().entries.filter((entry) => entry.id === first.id).map((entry) => entry.state))
      .toEqual(['timed_out', 'cancelled']);

    const replacement = await startReviewed(svc, reviewed(svc));
    svc.cancel(replacement.id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DiagnosticsService rate limits and failure classification', () => {
  it('honours reset metadata during polling, bounded by the job deadline', async () => {
    let now = 1_000;
    const sched = scheduler();
    let gets = 0;
    const svc = service([device()], {
      request: async (method, requestPath) => {
        if (method === 'POST') return { status: 202, body: { location: `${requestPath}/async-operations/reset-1` } };
        gets += 1;
        return gets === 1
          ? { status: 429, body: {}, retryAfterMs: 2_000, rateLimitResetAtMs: now + 12_000 }
          : { status: 200, body: { status: 'COMPLETED', output: { hops: [] } } };
      },
    }, {
      ...sched,
      nowMs: () => now,
      pollTimeoutMs: 20_000,
      pollInitialMs: 1_000,
      pollMaxMs: 4_000,
    });
    const job = await startReviewed(svc, reviewed(svc));
    await sched.run((ms) => { now += ms; });
    expect(sched.queue[0].delay).toBe(12_000);
    await sched.run((ms) => { now += ms; });
    expect(svc.status(job.id).state).toBe('succeeded');

    const deadlineSched = scheduler();
    const deadlineSvc = service([device()], {
      request: async (method, requestPath) => method === 'POST'
        ? { status: 202, body: { location: `${requestPath}/async-operations/reset-2` } }
        : { status: 429, body: {}, rateLimitResetAtMs: now + 30_000 },
    }, {
      ...deadlineSched,
      nowMs: () => now,
      pollTimeoutMs: 5_000,
      pollInitialMs: 1_000,
    });
    const deadlineJob = await startReviewed(deadlineSvc, reviewed(deadlineSvc));
    await deadlineSched.run();
    expect(deadlineSvc.status(deadlineJob.id).state).toBe('running');
    expect(deadlineSched.queue[0].delay).toBe(5_000);
    await deadlineSched.run((ms) => { now += ms; });
    expect(deadlineSvc.status(deadlineJob.id).state).toBe('timed_out');
  });

  it('returns honest initiation statuses for auth and transport failures', async () => {
    const statusAuth = service([device()], {
      request: async () => ({ status: 401, body: { access_token: 'never expose' } }),
    });
    await expect(startReviewed(statusAuth, reviewed(statusAuth))).rejects.toMatchObject({ status: 401 });

    const tokenAuth = service([device()], {
      request: async () => {
        throw new CentralRequestError('authentication', 'safe auth classification');
      },
    });
    await expect(startReviewed(tokenAuth, reviewed(tokenAuth))).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('authentication failed'),
    });

    const transport = service([device()], {
      request: async () => {
        throw new CentralRequestError('transport', 'secret upstream detail');
      },
    });
    await expect(startReviewed(transport, reviewed(transport))).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('outcome is unknown'),
    });

    const serviceFailure = service([device()], {
      request: async () => {
        throw new CentralRequestError('service', 'token endpoint body');
      },
    });
    await expect(startReviewed(serviceFailure, reviewed(serviceFailure))).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('authentication service was unavailable'),
    });
  });

  it('retains an unknown initiation reservation until its deadline, rejects retries, and audits expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T20:00:00Z'));
    const devices = [
      device({ serial: 'SERIAL-A' }),
      device({ name: 'ap-2', serial: 'SERIAL-B' }),
    ];
    let posts = 0;
    const svc = service(devices, {
      request: async () => {
        posts += 1;
        throw new CentralRequestError('transport', 'socket reset after dispatch');
      },
    }, {
      maxActiveJobs: 1,
      pollTimeoutMs: 10_000,
    });

    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-A'))).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('outcome is unknown'),
    });
    const unknownJob = [...(svc as unknown as {
      jobs: Map<string, { public: { id: string; state: string; message: string } }>;
    }).jobs.values()][0].public;
    expect(unknownJob).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('Capacity remains reserved'),
    });
    expect(vi.getTimerCount()).toBe(1);

    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-A'))).rejects.toMatchObject({ status: 409 });
    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({ status: 429 });
    expect(posts).toBe(1);

    await vi.advanceTimersByTimeAsync(9_999);
    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-A'))).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(svc.status(unknownJob.id).state).toBe('failed');
    expect(svc.history().entries.filter((entry) => entry.id === unknownJob.id).map((entry) => entry.state))
      .toEqual(['reservation_expired', 'initiation_unknown']);

    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({ status: 502 });
    expect(posts).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['missing identifiers', { status: 202, body: {} }],
    ['malformed Location header', { status: 202, location: '://not-a-location', body: {} }],
    ['wrong Location path', { status: 202, location: '/network-troubleshooting/v1/wrong/task-1', body: {} }],
    ['empty body location task', { status: 202, body: { location: '/network-troubleshooting/v1/aps/AP-SERIAL/traceroute/async-operations/' } }],
    ['malformed body taskId', { status: 202, body: { taskId: 'task/with/slashes' } }],
    ['sentinel body task_id', { status: 202, body: { task_id: 'unknown' } }],
  ] satisfies Array<[string, BrokerResponse]>)(
    'holds accepted-but-untrackable reservations for %s until the deadline',
    async (_name, firstResponse) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-29T20:30:00Z'));
      const devices = [
        device({ serial: 'SERIAL-A' }),
        device({ name: 'ap-2', serial: 'SERIAL-B' }),
      ];
      let posts = 0;
      let gets = 0;
      const svc = service(devices, {
        request: async (method) => {
          if (method === 'GET') {
            gets += 1;
            return { status: 500, body: {} };
          }
          posts += 1;
          return posts === 1 ? firstResponse : { status: 503, body: {} };
        },
      }, {
        maxActiveJobs: 1,
        pollTimeoutMs: 10_000,
      });

      await expect(startReviewed(svc, reviewed(svc, 'SERIAL-A'))).rejects.toMatchObject({
        status: 502,
        message: expect.stringContaining('accepted'),
      });
      const heldJob = [...(svc as unknown as {
        jobs: Map<string, { public: { id: string; state: string; taskId: string | null; message: string } }>;
      }).jobs.values()][0].public;
      expect(heldJob).toMatchObject({
        state: 'failed',
        taskId: null,
        message: expect.stringContaining('Do not retry before 2026-07-29T20:30:10.000Z'),
      });
      expect(gets).toBe(0);
      expect(vi.getTimerCount()).toBe(1);

      await expect(startReviewed(svc, reviewed(svc, 'SERIAL-A'))).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('accepted an untrackable diagnostic'),
      });
      await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({
        status: 429,
        message: expect.stringContaining('Central-accepted task that cannot be tracked'),
      });
      expect(posts).toBe(1);

      await vi.advanceTimersByTimeAsync(9_999);
      await expect(startReviewed(svc, reviewed(svc, 'SERIAL-A'))).rejects.toMatchObject({ status: 409 });
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(svc.history().entries.filter((entry) => entry.id === heldJob.id)).toMatchObject([
        { state: 'reservation_expired' },
        { state: 'accepted_untrackable', httpCode: 202 },
      ]);

      await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({ status: 502 });
      expect(posts).toBe(2);
      expect(gets).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ['Location header', (startPath: string): BrokerResponse => ({
      status: 202,
      location: `https://central.example${startPath}/async-operations/header-task`,
      body: {},
    }), 'header-task'],
    ['body taskId', (): BrokerResponse => ({
      status: 202,
      body: { taskId: 'body-task' },
    }), 'body-task'],
    ['body task_id', (): BrokerResponse => ({
      status: 202,
      body: { task_id: 'snake-task' },
    }), 'snake-task'],
  ] satisfies Array<[string, (startPath: string) => BrokerResponse, string]>)(
    'tracks accepted diagnostics from a valid %s',
    async (_name, responseFor, expectedTaskId) => {
      vi.useFakeTimers();
      const svc = service([device()], {
        request: async (method, requestPath) => method === 'POST'
          ? responseFor(requestPath)
          : { status: 200, body: { status: 'COMPLETED', output: { hops: [] } } },
      });

      const job = await startReviewed(svc, reviewed(svc));
      expect(job).toMatchObject({ state: 'running', taskId: expectedTaskId });
      await vi.advanceTimersByTimeAsync(0);
      expect(svc.status(job.id).state).toBe('succeeded');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('releases definite authentication and non-2xx initiation failures immediately', async () => {
    vi.useFakeTimers();
    const devices = [
      device({ serial: 'SERIAL-A' }),
      device({ name: 'ap-2', serial: 'SERIAL-B' }),
    ];
    let outcome: 'auth' | 'non-2xx' | 'accepted' = 'auth';
    const svc = service(devices, {
      request: async (_method, requestPath) => {
        if (outcome === 'auth') throw new CentralRequestError('authentication', 'rejected token');
        if (outcome === 'non-2xx') return { status: 503, body: {} };
        return { status: 202, body: { location: `${requestPath}/async-operations/released-slot` } };
      },
    }, { maxActiveJobs: 1 });

    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-A'))).rejects.toMatchObject({ status: 401 });
    expect(vi.getTimerCount()).toBe(0);
    outcome = 'non-2xx';
    await expect(startReviewed(svc, reviewed(svc, 'SERIAL-B'))).rejects.toMatchObject({ status: 502 });
    expect(vi.getTimerCount()).toBe(0);
    outcome = 'accepted';
    const replacement = await startReviewed(svc, reviewed(svc, 'SERIAL-A'));
    expect(replacement.state).toBe('running');
    svc.cancel(replacement.id);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates revoked polling credentials but retries transport failure', async () => {
    const authSched = scheduler();
    const devices = [
      device({ serial: 'SERIAL-A' }),
      device({ name: 'ap-2', serial: 'SERIAL-B' }),
    ];
    let authGets = 0;
    const auth = service(devices, {
      request: async (method, requestPath) => {
        if (method === 'POST') return { status: 202, body: { location: `${requestPath}/async-operations/auth-poll` } };
        authGets += 1;
        if (authGets === 1) throw new CentralRequestError('authentication', 'revoked credential');
        return { status: 200, body: { status: 'COMPLETED', output: { hops: [] } } };
      },
    }, { ...authSched, maxActiveJobs: 1 });
    const authJob = await startReviewed(auth, reviewed(auth, 'SERIAL-A'));
    await authSched.run();
    expect(auth.status(authJob.id)).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('authentication failed while polling'),
    });
    expect(auth.status(authJob.id).message).toContain('Capacity remains reserved');
    await expect(startReviewed(auth, reviewed(auth, 'SERIAL-B'))).rejects.toMatchObject({ status: 429 });
    await authSched.run();
    expect(auth.status(authJob.id).state).toBe('failed');
    expect((await startReviewed(auth, reviewed(auth, 'SERIAL-B'))).state).toBe('running');

    const forbiddenSched = scheduler();
    let forbiddenGets = 0;
    const forbidden = service(devices, {
      request: async (method, requestPath) => {
        if (method === 'POST') {
          return { status: 202, body: { location: `${requestPath}/async-operations/forbidden-poll` } };
        }
        forbiddenGets += 1;
        return forbiddenGets === 1
          ? { status: 403, body: { detail: 'must-not-escape' } }
          : { status: 200, body: { status: 'FAILED' } };
      },
    }, { ...forbiddenSched, maxActiveJobs: 1 });
    const forbiddenJob = await startReviewed(forbidden, reviewed(forbidden, 'SERIAL-A'));
    await forbiddenSched.run();
    expect(forbidden.status(forbiddenJob.id)).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('not authorised'),
    });
    expect(forbidden.status(forbiddenJob.id).message).not.toContain('must-not-escape');
    await expect(startReviewed(forbidden, reviewed(forbidden, 'SERIAL-B'))).rejects.toMatchObject({ status: 429 });
    await forbiddenSched.run();
    expect((await startReviewed(forbidden, reviewed(forbidden, 'SERIAL-B'))).state).toBe('running');

    const transportSched = scheduler();
    let gets = 0;
    const transport = service([device()], {
      request: async (method, requestPath) => {
        if (method === 'POST') return { status: 202, body: { location: `${requestPath}/async-operations/transport-poll` } };
        gets += 1;
        if (gets === 1) throw new CentralRequestError('transport', 'network detail');
        return { status: 200, body: { status: 'COMPLETED', output: { hops: [] } } };
      },
    }, transportSched);
    const transportJob = await startReviewed(transport, reviewed(transport));
    await transportSched.run();
    expect(transport.status(transportJob.id)).toMatchObject({
      state: 'running',
      message: expect.stringContaining('transport failed'),
    });
    expect(transportSched.queue[0].delay).toBeGreaterThan(0);
    await transportSched.run();
    expect(transport.status(transportJob.id).state).toBe('succeeded');
  });
});

describe('DiagnosticsService audit history', () => {
  it('writes mode-0600 redacted records with device name, plane, and serial', async () => {
    const file = path.join(root, 'diagnostics-history.jsonl');
    fs.rmSync(file, { force: true });
    const sched = scheduler();
    const svc = service([device()], {
      request: async (method, requestPath) => method === 'POST'
        ? { status: 202, body: { location: `${requestPath}/async-operations/audit-1`, token: 'upstream-secret' } }
        : { status: 200, body: { status: 'COMPLETED', rawOutput: 'private route', output: { hops: [] } } },
    }, sched);
    const review = reviewed(svc, 'AP-SERIAL', 'sensitive.example');
    const job = await startReviewed(svc, review);
    await sched.run();
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('"target":"[redacted]"');
    expect(raw).toContain('"device":"ap-1"');
    expect(raw).toContain('"serial":"AP-SERIAL"');
    expect(raw).toContain('"plane":"CENTRAL"');
    expect(raw).not.toContain('sensitive.example');
    expect(raw).not.toContain('upstream-secret');
    expect(raw).not.toContain('private route');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(svc.history().entries.find((entry) => entry.id === job.id)).toMatchObject({
      device: 'ap-1',
      serial: 'AP-SERIAL',
      plane: 'CENTRAL',
      state: 'succeeded',
    });
  });

  /* A JSONL append that was interrupted leaves a half-written final line, and
   * an entry written before a field the parser now insists on fails the same
   * guard. Both used to vanish: the run happened, the record was written, and
   * the audit log quietly stopped mentioning it. Schema drift silently
   * erasing runs is the failure an audit log exists to prevent. */
  it('counts lines it could not read as runs, and does not call them retention', () => {
    const file = path.join(root, 'diagnostics-history.jsonl');
    const good = {
      id: 'ok-1', at: '2026-07-29T10:00:00Z', device: 'ap-1', serial: 'AP-SERIAL',
      plane: 'CENTRAL', operation: 'traceroute', state: 'succeeded', target: '[redacted]',
    };
    fs.writeFileSync(file, [
      JSON.stringify(good),
      '{"id":"truncated-by-a-crash","at":"2026-07-29T10:0',
      JSON.stringify({ ...good, id: 'older-format', serial: undefined }),
      'not json at all',
    ].join('\n') + '\n');

    const svc = service([device()], { request: async () => ({ status: 200, body: {} }) });
    const read = svc.history();
    expect(read.entries.map((e) => e.id)).toEqual(['ok-1']);
    expect(read.malformed).toBe(3);
    // Not laundered into a cause that has its own words in the panel.
    expect(read.discarded).toEqual([]);
    expect(read.unreadable).toEqual([]);
  });

  /* The cap counts runs across ALL devices and the panel then filters to one,
   * so a device diagnosed a while back can be pushed off the end entirely by
   * other devices' activity — and its panel shows nothing whatsoever. That is
   * a window used as though it were a complete record. */
  it('reports a read that stopped at its limit, and does not cry truncation over a whole log', () => {
    const file = path.join(root, 'diagnostics-history.jsonl');
    const row = (n: number) => JSON.stringify({
      id: `run-${n}`, at: `2026-07-29T10:00:${String(n % 60).padStart(2, '0')}Z`,
      device: 'ap-1', serial: 'AP-SERIAL', plane: 'CENTRAL',
      operation: 'traceroute', state: 'succeeded', target: '[redacted]',
    });

    fs.writeFileSync(file, Array.from({ length: 5 }, (_, i) => row(i)).join('\n') + '\n');
    expect(service([device()], { request: async () => ({ status: 200, body: {} }) }).history().truncated).toBe(false);

    // MAX_HISTORY is 100; one more line than that exists behind the read.
    fs.writeFileSync(file, Array.from({ length: 140 }, (_, i) => row(i)).join('\n') + '\n');
    const capped = service([device()], { request: async () => ({ status: 200, body: {} }) }).history();
    expect(capped.truncated).toBe(true);
    expect(capped.entries.length).toBe(100);
  });

  /* Rotation deletes the oldest generation and leaves a tombstone in its
   * place, precisely so a deleted stretch of history does not read as a
   * stretch in which nothing happened. Every reader of a rotating log applies
   * a type guard for its own row shape, and a tombstone fails all of them —
   * no id, no operation, no state, because nothing was run. Dropped by the
   * guard, the disclosure the write path paid for never reaches anybody. */
  it('reports a generation the retention policy discarded, with the span it covered', () => {
    const file = path.join(root, 'diagnostics-history.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({
        ts: '2026-07-30T00:00:00.000Z',
        event: 'log-retention',
        result: 'discarded',
        file: 'diagnostics-history.5.jsonl',
        bytes: 16_777_216,
        coveringFrom: '2026-01-05T12:00:00.000Z',
        coveringTo: '2026-02-11T12:00:00.000Z',
        note: 'oldest retained generation deleted by retention policy',
      }),
      JSON.stringify({
        id: 'kept-1',
        at: '2026-07-30T01:00:00.000Z',
        device: 'ap-1',
        serial: 'AP-SERIAL',
        plane: 'CENTRAL',
        operation: 'traceroute',
        state: 'succeeded',
        target: '[redacted]',
      }),
    ].join('\n') + '\n');

    const read = service([device()], { request: async () => ({ status: 200, body: {} }) }, scheduler()).history();
    expect(read.discarded).toEqual([
      { from: '2026-01-05T12:00:00.000Z', to: '2026-02-11T12:00:00.000Z' },
    ]);
    // The tombstone must not be smuggled into the list as if it were a run.
    expect(read.entries.map((entry) => entry.id)).toEqual(['kept-1']);
  });

  // timeSpan returns null when the deleted generation's own lines would not
  // parse. The gap is still a fact; only its width is unknown.
  it('still reports a discarded generation whose covered span could not be read', () => {
    const file = path.join(root, 'diagnostics-history.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      ts: '2026-07-30T00:00:00.000Z',
      event: 'log-retention',
      result: 'discarded',
      file: 'diagnostics-history.5.jsonl',
      bytes: 4096,
      note: 'oldest retained generation deleted by retention policy',
    }) + '\n');

    const read = service([device()], { request: async () => ({ status: 200, body: {} }) }, scheduler()).history();
    expect(read.discarded).toEqual([{ from: null, to: null }]);
  });

  // Must not over-apply: a log with nothing but real runs claims no holes.
  it('claims no gaps when every line is a run', () => {
    const file = path.join(root, 'diagnostics-history.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      id: 'only-1',
      at: '2026-07-30T01:00:00.000Z',
      device: 'ap-1',
      serial: 'AP-SERIAL',
      plane: 'CENTRAL',
      operation: 'traceroute',
      state: 'succeeded',
      target: '[redacted]',
    }) + '\n');

    const read = service([device()], { request: async () => ({ status: 200, body: {} }) }, scheduler()).history();
    expect(read).toMatchObject({ discarded: [], unreadable: [] });
    expect(read.entries.length).toBe(1);
  });

  // A missing file is a portal that has never run a diagnostic — an absence
  // of runs, not an absence of evidence. It must not imply a hole.
  it('reports no gaps when the history file does not exist', () => {
    fs.rmSync(path.join(root, 'diagnostics-history.jsonl'), { force: true });

    expect(service([device()], { request: async () => ({ status: 200, body: {} }) }, scheduler()).history())
      .toEqual({ entries: [], discarded: [], unreadable: [], malformed: 0, truncated: false });
  });
});
