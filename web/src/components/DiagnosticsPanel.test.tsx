import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import {
  DiagnosticJobStatusError,
  getDiagnosticEligibility,
  getDiagnosticHistory,
  getDiagnosticJob,
  reviewDiagnostic,
  startDiagnostic,
} from '../api/client';
import type {
  DiagnosticAuditEntry,
  DiagnosticEligibleDevice,
  DiagnosticHistoryRead,
  DiagnosticJob,
  DiagnosticReview,
} from '@hpe/shared';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    cancelDiagnostic: vi.fn(),
    getDiagnosticEligibility: vi.fn(),
    getDiagnosticHistory: vi.fn(),
    getDiagnosticJob: vi.fn(),
    reviewDiagnostic: vi.fn(),
    startDiagnostic: vi.fn(),
  };
});

const eligibility = vi.mocked(getDiagnosticEligibility);
const history = vi.mocked(getDiagnosticHistory);
/** A history read with no known holes — the shape most tests want. */
const historyOf = (
  entries: DiagnosticAuditEntry[] = [],
  gaps: Partial<Pick<DiagnosticHistoryRead, 'discarded' | 'unreadable'>> = {},
): DiagnosticHistoryRead => ({
  entries,
  discarded: gaps.discarded ?? [],
  unreadable: gaps.unreadable ?? [],
});
const review = vi.mocked(reviewDiagnostic);
const start = vi.mocked(startDiagnostic);
const status = vi.mocked(getDiagnosticJob);

const AP: DiagnosticEligibleDevice = {
  name: 'ap-1',
  serial: 'AP-SERIAL',
  plane: 'CENTRAL',
  type: 'ap',
  model: 'AP-635',
  deviceClass: 'ap',
  eligible: true,
  reason: 'Eligible for reviewed New Central traceroute',
};

const CX: DiagnosticEligibleDevice = {
  ...AP,
  name: 'cx-1',
  serial: 'CX-SERIAL',
  type: 'switch',
  model: 'CX-6300M',
  deviceClass: 'cx',
};

function apReview(overrides: Partial<DiagnosticReview> = {}): DiagnosticReview {
  return {
    reviewId: 'r1',
    expiresAt: '2026-07-29T12:00:00Z',
    device: 'ap-1',
    serial: 'AP-SERIAL',
    plane: 'CENTRAL',
    deviceClass: 'ap',
    operation: 'traceroute',
    target: 'example.net',
    options: { sourceInterface: 'eth0' },
    startPath: '/network-troubleshooting/v1/aps/AP-SERIAL/traceroute',
    pollPathTemplate: '/network-troubleshooting/v1/aps/AP-SERIAL/traceroute/async-operations/{task-id}',
    warning: 'operational action',
    ...overrides,
  };
}

function apJob(overrides: Partial<DiagnosticJob> = {}): DiagnosticJob {
  return {
    id: 'j1',
    device: 'ap-1',
    serial: 'AP-SERIAL',
    plane: 'CENTRAL',
    deviceClass: 'ap',
    operation: 'traceroute',
    state: 'running',
    taskId: 't1',
    progressPercent: 0,
    startedAt: '2026-07-29T11:00:00Z',
    finishedAt: null,
    message: 'running',
    result: null,
    ...overrides,
  };
}

/** A promise the test controls the settlement of, to simulate a slow/racing
 *  network response arriving at an arbitrary later point. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('DiagnosticsPanel', () => {
  it('keeps Classic Central disabled with an honest no-fallback reason', async () => {
    eligibility.mockResolvedValue({
      operation: 'traceroute',
      source: 'live-inventory',
      devices: [{
        ...AP,
        name: 'classic-ap',
        plane: 'CLASSIC',
        deviceClass: null,
        eligible: false,
        reason: 'Classic Central is read-only here; active diagnostics require New Central',
      }],
    });
    history.mockResolvedValue(historyOf());
    render(<DiagnosticsPanel deviceName="classic-ap" plane="CLASSIC" serial="AP-SERIAL" />);
    expect(await screen.findByText('Active diagnostics disabled')).toBeTruthy();
    expect(screen.getByText(/No shell fallback or guessed operation/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review traceroute' })).toBeNull();
  });

  it('requires a separate review step before explicit confirmation starts AP traceroute, sending plane+serial', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview());
    start.mockResolvedValue(apJob({
      state: 'succeeded',
      progressPercent: 100,
      finishedAt: '2026-07-29T11:00:02Z',
      message: 'Traceroute completed',
      result: { device: 'ap-1', serial: 'AP-SERIAL', plane: 'CENTRAL', destination: 'example.net', resolvedIp: '192.0.2.1', hops: [] },
    }));
    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    fireEvent.change(await screen.findByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.change(screen.getByLabelText('Source interface (optional)'), { target: { value: 'eth0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    expect(await screen.findByText('Operator review')).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledWith({
      plane: 'CENTRAL',
      serial: 'AP-SERIAL',
      operation: 'traceroute',
      target: 'example.net',
      options: { sourceInterface: 'eth0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run traceroute' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('r1', 'CENTRAL', 'AP-SERIAL'));
    expect(await screen.findByText('succeeded')).toBeTruthy();
  });

  it('renders unanswered normalized hops as stars, never literal null text', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview());
    start.mockResolvedValue(apJob({
      state: 'succeeded',
      progressPercent: 100,
      finishedAt: '2026-07-29T11:00:02Z',
      message: 'Traceroute completed',
      result: {
        device: 'ap-1',
        serial: 'AP-SERIAL',
        plane: 'CENTRAL',
        destination: null,
        resolvedIp: null,
        hops: [
          { hop: '1', probes: [{ ipAddress: null, reverseDnsResolution: null, responseTimeMilliseconds: null }] },
          { hop: '*', probes: [] },
        ],
      },
    }));
    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    fireEvent.change(await screen.findByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    await screen.findByText('Operator review');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run traceroute' }));
    await screen.findByText('succeeded');

    expect(screen.queryByText(/^null$/i)).toBeNull();
    expect(screen.getAllByText('*').length).toBeGreaterThanOrEqual(2);
  });

  it('submits only documented CX options and renders an async failure', async () => {
    vi.useFakeTimers();
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [CX] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview({
      reviewId: 'r2',
      device: 'cx-1',
      serial: 'CX-SERIAL',
      deviceClass: 'cx',
      target: '2001:db8::1',
      options: { useIpv6: true, useManagementInterface: true, vrfName: 'blue' },
      startPath: '/network-troubleshooting/v1/cx/CX-SERIAL/traceroute',
      pollPathTemplate: '/network-troubleshooting/v1/cx/CX-SERIAL/traceroute/async-operations/{task-id}',
    }));
    start.mockResolvedValue(apJob({
      id: 'j2',
      device: 'cx-1',
      serial: 'CX-SERIAL',
      deviceClass: 'cx',
      state: 'running',
      taskId: 't2',
    }));
    status.mockResolvedValue(apJob({
      id: 'j2',
      device: 'cx-1',
      serial: 'CX-SERIAL',
      deviceClass: 'cx',
      state: 'failed',
      taskId: 't2',
      progressPercent: 10,
      finishedAt: '2026-07-29T11:00:01Z',
      message: 'Traceroute failed: Destination not resolved',
    }));
    render(<DiagnosticsPanel deviceName="cx-1" plane="CENTRAL" serial="CX-SERIAL" />);
    await act(async () => Promise.resolve());
    fireEvent.change(screen.getByLabelText('Traceroute target'), { target: { value: '2001:db8::1' } });
    fireEvent.change(screen.getByLabelText('VRF name (optional)'), { target: { value: 'blue' } });
    fireEvent.click(screen.getByLabelText('Use IPv6'));
    fireEvent.click(screen.getByLabelText('Use management interface'));
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    await act(async () => Promise.resolve());
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      plane: 'CENTRAL',
      serial: 'CX-SERIAL',
      options: { useIpv6: true, useManagementInterface: true, vrfName: 'blue' },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run traceroute' }));
    await act(async () => Promise.resolve());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByText(/Destination not resolved/)).toBeTruthy();
  });

  it('clears review, job, inputs and stale history immediately on a device switch', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf([{ id: 'h1', at: '2026-07-29T10:00:00Z', device: 'ap-1', serial: 'AP-SERIAL', plane: 'CENTRAL', operation: 'traceroute', state: 'reviewed', target: '[redacted]' }]));
    review.mockResolvedValue(apReview());

    const { rerender } = render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    fireEvent.change(await screen.findByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    expect(await screen.findByText('Operator review')).toBeTruthy();
    expect(await screen.findByText(/Recent audit history/)).toBeTruthy();

    // Switch to a different plane+serial identity — a same-named device row
    // in the new eligibility list must never be confused with the old one.
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [CX] });
    history.mockResolvedValue(historyOf());
    rerender(<DiagnosticsPanel deviceName="cx-1" plane="CENTRAL" serial="CX-SERIAL" />);

    await waitFor(() => expect(screen.queryByText('Operator review')).toBeNull());
    expect(screen.queryByText(/Recent audit history/)).toBeNull();
    const targetInput = await screen.findByLabelText('Traceroute target') as HTMLInputElement;
    expect(targetInput.value).toBe('');
    expect(eligibility).toHaveBeenCalledTimes(2);
  });

  it('never shows a review response that arrives after switching devices', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    const staleReview = deferred<DiagnosticReview>();
    review.mockReturnValueOnce(staleReview.promise);

    const { rerender } = render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    fireEvent.change(await screen.findByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    expect(await screen.findByText('Validating…')).toBeTruthy();

    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [CX] });
    rerender(<DiagnosticsPanel deviceName="cx-1" plane="CENTRAL" serial="CX-SERIAL" />);
    await waitFor(() => expect(screen.getByLabelText('Traceroute target')).toBeTruthy());

    await act(async () => {
      staleReview.resolve(apReview());
      await Promise.resolve();
    });
    expect(screen.queryByText('Operator review')).toBeNull();
  });

  it('never confirms a review created for a previous device when start resolves late', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview());
    const staleStart = deferred<DiagnosticJob>();
    start.mockReturnValueOnce(staleStart.promise);

    const { rerender } = render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    fireEvent.change(await screen.findByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    expect(await screen.findByText('Operator review')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run traceroute' }));
    expect(await screen.findByText('Starting…')).toBeTruthy();

    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [CX] });
    rerender(<DiagnosticsPanel deviceName="cx-1" plane="CENTRAL" serial="CX-SERIAL" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review traceroute' })).toBeTruthy());

    await act(async () => {
      staleStart.resolve(apJob());
      await Promise.resolve();
    });
    expect(screen.queryByText('running')).toBeNull();
    expect(screen.getByRole('button', { name: 'Review traceroute' })).toBeTruthy();
  });

  it('retries transient job-status failures with bounded exponential backoff until it recovers', async () => {
    vi.useFakeTimers();
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview());
    start.mockResolvedValue(apJob());
    let calls = 0;
    status.mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) throw new Error('temporary network blip');
      return apJob({ state: 'succeeded', progressPercent: 100, message: 'Traceroute completed', finishedAt: '2026-07-29T11:00:02Z' });
    });

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await act(async () => Promise.resolve());
    fireEvent.change(screen.getByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run traceroute' }));
    await act(async () => Promise.resolve());

    // Initial poll (500ms) fails → schedules a 1000ms retry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/retrying/)).toBeTruthy();

    // First retry (1000ms) fails too → schedules a 2000ms retry (doubled).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(status).toHaveBeenCalledTimes(2);

    // Second retry (2000ms) succeeds → terminal state, polling stops.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(status).toHaveBeenCalledTimes(3);
    expect(screen.getByText('succeeded')).toBeTruthy();
    expect(screen.queryByText(/retrying/)).toBeNull();

    // No further polls after the terminal state is reached.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(status).toHaveBeenCalledTimes(3);
  });

  it('stops polling with an honest message once persistent failures exceed the client-side deadline', async () => {
    vi.useFakeTimers();
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview());
    start.mockResolvedValue(apJob());
    status.mockRejectedValue(new Error('portal unreachable'));

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await act(async () => Promise.resolve());
    fireEvent.change(screen.getByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run traceroute' }));
    await act(async () => Promise.resolve());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(screen.getByText(/giving up/)).toBeTruthy();
    const callsAtStop = status.mock.calls.length;
    expect(callsAtStop).toBeGreaterThan(0);

    // Confirm it really has stopped — no further calls however long we wait.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(status.mock.calls.length).toBe(callsAtStop);
  });

  it('stops immediately with an honest message on an answered 404, without retrying', async () => {
    vi.useFakeTimers();
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview());
    start.mockResolvedValue(apJob());
    status.mockRejectedValue(new DiagnosticJobStatusError(404, 'diagnostic job not found'));

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await act(async () => Promise.resolve());
    fireEvent.change(screen.getByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run traceroute' }));
    await act(async () => Promise.resolve());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/could not be found/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('never overlaps polls — a slow in-flight status check blocks the next tick', async () => {
    vi.useFakeTimers();
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview());
    start.mockResolvedValue(apJob());
    const slow = deferred<DiagnosticJob>();
    status.mockReturnValueOnce(slow.promise);

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await act(async () => Promise.resolve());
    fireEvent.change(screen.getByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run traceroute' }));
    await act(async () => Promise.resolve());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(status).toHaveBeenCalledTimes(1);

    // Time keeps passing while the first call is still in flight — no second
    // call may be issued until the first one settles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(status).toHaveBeenCalledTimes(1);

    status.mockResolvedValue(apJob({ state: 'running' }));
    await act(async () => {
      slow.resolve(apJob({ state: 'running' }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('clears its poll timer and stops updating state after unmount', async () => {
    vi.useFakeTimers();
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview());
    start.mockResolvedValue(apJob());
    status.mockResolvedValue(apJob({ state: 'running' }));

    const { unmount } = render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await act(async () => Promise.resolve());
    fireEvent.change(screen.getByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run traceroute' }));
    await act(async () => Promise.resolve());

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(status).not.toHaveBeenCalled();
  });

  it('loads eligibility and history under React.StrictMode despite the simulated double-effect mount', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());

    render(
      <StrictMode>
        <DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />
      </StrictMode>,
    );

    // If the mounted-ref regression regresses, this spins forever: the
    // simulated StrictMode unmount+remount leaves mountedRef stuck false and
    // the eligibility/history response is dropped as "stale" even though it
    // is the only response in flight.
    expect(await screen.findByLabelText('Traceroute target')).toBeTruthy();
    expect(screen.queryByText(/Active diagnostics disabled/)).toBeNull();
    expect(screen.queryByText(/Not in live inventory/)).toBeNull();
  });

  it('invalidates an in-flight review the instant an input is edited, even for the same device', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    const staleReview = deferred<DiagnosticReview>();
    review.mockReturnValueOnce(staleReview.promise);

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    fireEvent.change(await screen.findByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    expect(await screen.findByText('Validating…')).toBeTruthy();

    // Edit the target while the review request for the original target is
    // still in flight — the response, once it lands, must not be shown
    // because it no longer describes what's on screen.
    fireEvent.change(screen.getByLabelText('Traceroute target'), { target: { value: 'changed.example.net' } });

    await act(async () => {
      staleReview.resolve(apReview({ target: 'example.net' }));
      await Promise.resolve();
    });
    expect(screen.queryByText('Operator review')).toBeNull();
    expect(screen.getByRole('button', { name: 'Review traceroute' })).toBeTruthy();
    expect((screen.getByLabelText('Traceroute target') as HTMLInputElement).value).toBe('changed.example.net');
  });

  it('never confirms a review whose form snapshot no longer matches the visible inputs', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf());
    review.mockResolvedValue(apReview({ target: 'example.net' }));

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    fireEvent.change(await screen.findByLabelText('Traceroute target'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review traceroute' }));
    expect(await screen.findByText('Operator review')).toBeTruthy();

    // The review disappears the moment the operator edits an input again —
    // exercised directly here as a defence-in-depth check on confirmStart's
    // own form-version guard, not just the input's own reset wiring.
    fireEvent.change(screen.getByLabelText('Traceroute target'), { target: { value: 'changed.example.net' } });
    expect(screen.queryByText('Operator review')).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('filters audit history by exact plane+serial, never mixing entries from a same-named device', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf([
      { id: 'h1', at: '2026-07-29T10:00:00Z', device: 'shared-name', serial: 'AP-SERIAL', plane: 'CENTRAL', operation: 'traceroute', state: 'reviewed', target: '[redacted]' },
      { id: 'h2', at: '2026-07-29T10:05:00Z', device: 'shared-name', serial: 'OTHER-SERIAL', plane: 'CENTRAL', operation: 'traceroute', state: 'reviewed', target: '[redacted]' },
      { id: 'h3', at: '2026-07-29T10:10:00Z', device: 'shared-name', serial: 'AP-SERIAL', plane: 'CLASSIC', operation: 'traceroute', state: 'reviewed', target: '[redacted]' },
    ]));

    render(<DiagnosticsPanel deviceName="shared-name" plane="CENTRAL" serial="AP-SERIAL" />);
    await screen.findByLabelText('Traceroute target');

    expect(await screen.findByText(/Recent audit history/)).toBeTruthy();
    // Only the entry matching this exact plane+serial identity is shown —
    // the same-named device on a different serial/plane must not leak in.
    expect(screen.getByText(/CENTRAL\/AP-SERIAL/)).toBeTruthy();
    expect(screen.queryByText(/CENTRAL\/OTHER-SERIAL/)).toBeNull();
    expect(screen.queryByText(/CLASSIC\/AP-SERIAL/)).toBeNull();
  });

  /* A hole in the audit log is not a hole in this device's runs, and the
   * identity filter above is exactly why it has to be said out loud: a
   * generation that retention deleted or that will not open cannot be
   * searched for this serial. The rows we cannot rule out are precisely the
   * ones that are gone, so the panel's list is short in a way the list itself
   * has no way of showing. */
  const GAP_HISTORY = { discarded: [{ from: '2026-01-05T12:00:00Z', to: '2026-02-11T12:00:00Z' }] };

  it('discloses a discarded generation even when this device has runs to show', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf(
      [{ id: 'h1', at: '2026-07-29T10:00:00Z', device: 'ap-1', serial: 'AP-SERIAL', plane: 'CENTRAL', operation: 'traceroute', state: 'reviewed', target: '[redacted]' }],
      GAP_HISTORY,
    ));

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await screen.findByLabelText('Traceroute target');

    expect(await screen.findByText('Audit history is incomplete')).toBeTruthy();
    expect(screen.getByText(/discarded by the retention policy/)).toBeTruthy();
    // The rows that survived are still shown; a disclosure that hid them
    // would trade one missing fact for another.
    expect(screen.getByText(/CENTRAL\/AP-SERIAL/)).toBeTruthy();
  });

  // The dangerous shape: no rows AND a hole. An empty list alone reads as
  // "this device has never been diagnosed", which may be false.
  it('does not let an empty list stand as proof a device was never diagnosed', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf([], GAP_HISTORY));

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await screen.findByLabelText('Traceroute target');

    expect(await screen.findByText('Audit history is incomplete')).toBeTruthy();
    expect(screen.getByText(/including any that would have appeared here/)).toBeTruthy();
  });

  it('discloses a rotated generation that could not be read', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf([], { unreadable: ['diagnostics-history.2.jsonl'] }));

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await screen.findByLabelText('Traceroute target');

    expect(await screen.findByText('Audit history is incomplete')).toBeTruthy();
    expect(screen.getByText(/could not be read/)).toBeTruthy();
  });

  // Must not over-apply: a warning shown over an intact log is a warning
  // operators learn to scroll past.
  it('says nothing about gaps when the log is whole', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP] });
    history.mockResolvedValue(historyOf([]));

    render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await screen.findByLabelText('Traceroute target');

    expect(screen.queryByText('Audit history is incomplete')).toBeNull();
  });

  it('drops a previous device\u2019s gap disclosure when the identity changes', async () => {
    eligibility.mockResolvedValue({ operation: 'traceroute', source: 'live-inventory', devices: [AP, CX] });
    history.mockResolvedValue(historyOf([], GAP_HISTORY));

    const view = render(<DiagnosticsPanel deviceName="ap-1" plane="CENTRAL" serial="AP-SERIAL" />);
    await screen.findByLabelText('Traceroute target');
    expect(await screen.findByText('Audit history is incomplete')).toBeTruthy();

    history.mockResolvedValue(historyOf([]));
    view.rerender(<DiagnosticsPanel deviceName="cx-1" plane="CENTRAL" serial="CX-SERIAL" />);
    // Synchronously cleared on the switch, before the new read lands.
    expect(screen.queryByText('Audit history is incomplete')).toBeNull();
    await act(async () => Promise.resolve());
    expect(screen.queryByText('Audit history is incomplete')).toBeNull();
  });
});
