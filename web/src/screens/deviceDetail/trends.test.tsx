/**
 * web/src/screens/deviceDetail/trends.test.tsx — the 'Hardware trends' panel.
 *
 * The api client (../../api/client) is mocked at the module boundary; the
 * payloads are the REAL shared demo fixtures (already normalized TrendSets —
 * sw-core-a's 03:00–05:00 telemetry gap, CPU excursion and CRC burst; ap-1f-04's
 * cpu/memory/throughput), so a rendering regression shows up against the same
 * numbers the showcase carries. Coverage:
 *   (a) switch tiles + per-series sparklines, with the gap rendered as a break
 *   (b) the PoE budget bar (consumption vs available)
 *   (c) interface error counters: movers get rows, zeros collapse to one line
 *   (d) every-zero counters state the healthy fact once, not ten rows
 *   (e) the four read outcomes, worded four ways (not-reported / failed read /
 *       failed section / empty)
 *   (f) AP metrics: tiles, bit/s throughput labels
 *   (g) on-demand wiring: the window control re-fetches with the new span
 *   (h) the pure helpers (rateText, gapPhrase, counterWindowTotal)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  AP_TRENDS_DEMO,
  SWITCH_HARDWARE_TRENDS_DEMO,
  SWITCH_INTERFACE_TRENDS_DEMO,
  hhmmLocal as hhmm,
  interfaceTrendSpecs,
  normalizeTrendSet,
  type SwitchInterfaceTrendsLive,
} from '@hpe/shared';
import { HardwareTrendsPanel, counterWindowTotal, gapPhrase, rateText } from './trends';
import {
  getDeviceApTrends,
  getDeviceHardwareTrends,
  getDeviceInterfaceTrends,
} from '../../api/client';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    getDeviceHardwareTrends: vi.fn(),
    getDeviceInterfaceTrends: vi.fn(),
    getDeviceApTrends: vi.fn(),
  };
});

const mockHardware = vi.mocked(getDeviceHardwareTrends);
const mockInterfaces = vi.mocked(getDeviceInterfaceTrends);
const mockApTrends = vi.mocked(getDeviceApTrends);

const HW = SWITCH_HARDWARE_TRENDS_DEMO['sw-core-a']!;
const IF = SWITCH_INTERFACE_TRENDS_DEMO['sw-core-a']!;
const AP_CPU = AP_TRENDS_DEMO['ap-1f-04|cpu']!;
const AP_MEM = AP_TRENDS_DEMO['ap-1f-04|memory']!;
const AP_TPUT = AP_TRENDS_DEMO['ap-1f-04|throughput']!;

function mockSwitchReads(
  hardware: Awaited<ReturnType<typeof getDeviceHardwareTrends>> = { kind: 'ok', live: HW },
  interfaces: Awaited<ReturnType<typeof getDeviceInterfaceTrends>> = { kind: 'ok', live: IF },
) {
  mockHardware.mockResolvedValue(hardware);
  mockInterfaces.mockResolvedValue(interfaces);
}

function mockApReads() {
  mockApTrends.mockImplementation((_name, metric) => {
    const live = metric === 'cpu' ? AP_CPU : metric === 'memory' ? AP_MEM : AP_TPUT;
    return Promise.resolve({ kind: 'ok', live });
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (a/b) switch tiles, sparklines, the gap break, the PoE budget bar
// ---------------------------------------------------------------------------

describe('HardwareTrendsPanel — switch hardware gauges', () => {
  it('renders the stat tiles from the latest samples, one sparkline row per series', async () => {
    mockSwitchReads();
    render(<HardwareTrendsPanel name="sw-core-a" type="switch" identity={{ plane: 'CENTRAL' }} />);

    // Latest samples of the authored window (hour 23): cpu 87, memory 44,
    // temp 57.6, PoE draw 186 of the flat 370 budget.
    expect(await screen.findByText('87%')).toBeTruthy();
    expect(screen.getByText('44%')).toBeTruthy();
    expect(screen.getByText('57.6 °C')).toBeTruthy();
    expect(screen.getByText('186 W')).toBeTruthy();

    // "Current" is captioned as the latest SAMPLE, never a live claim.
    expect(screen.getAllByText(/latest sample \d{2}:\d{2}/).length).toBeGreaterThanOrEqual(3);

    // One sparkline row per series that carried samples (all seven here).
    expect(screen.getByRole('img', { name: /CPU trend, 22 samples/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Memory trend, 22 samples/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /System temp trend, 22 samples/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /PoE budget trend, 22 samples/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Total power trend, 22 samples/ })).toBeTruthy();

    // Provenance: the plane and the window are named.
    expect(screen.getByText('CENTRAL · 24H')).toBeTruthy();
  });

  it('renders the 03:00–05:00 telemetry gap as a break, never a bridged line', async () => {
    mockSwitchReads();
    render(<HardwareTrendsPanel name="sw-core-a" type="switch" identity={{ plane: 'CENTRAL' }} />);

    // Every series names the break in its accessible label…
    const broken = await screen.findAllByRole('img', { name: /line broken where samples are missing/ });
    expect(broken.length).toBe(7);

    // …and the caption words the outage from the missing buckets themselves.
    const cpu = HW.trends!.series[0]!;
    const hole = cpu.points.find((p) => p.v === null)!;
    const after = cpu.points.find((p) => p.t > hole.t && p.v !== null)!;
    expect(
      screen.getAllByText(new RegExp(`no samples ${hhmm(hole.t)}–${hhmm(after.t)}`)).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('draws the PoE budget as consumption against available', async () => {
    mockSwitchReads();
    render(<HardwareTrendsPanel name="sw-core-a" type="switch" identity={{ plane: 'CENTRAL' }} />);
    // The tile (and its series row) name the draw; the caption names the budget.
    expect((await screen.findAllByText('PoE draw')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/of 370 W budget/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (c/d) interface error counters — the reference collapse rule
// ---------------------------------------------------------------------------

describe('HardwareTrendsPanel — interface error counters', () => {
  it('gives the burst counters rows with window totals and collapses the zeros', async () => {
    mockSwitchReads();
    render(<HardwareTrendsPanel name="sw-core-a" type="switch" identity={{ plane: 'CENTRAL' }} />);

    // The excursion's mark: inCrcErrors 4+9+12+6, inErrors 3+5+7+4, inDiscards 2.
    expect(await screen.findByText('CRC errors')).toBeTruthy();
    expect(screen.getByText('31 in the window')).toBeTruthy();
    expect(screen.getByText('19 in the window')).toBeTruthy();
    expect(screen.getByText('2 in the window')).toBeTruthy();
    expect(screen.getByText('Interface errors')).toBeTruthy();
    expect(screen.getByText('3 counters MOVED')).toBeTruthy();

    // The seven quiet counters are stated once, together — not seven rows.
    expect(
      screen.getByText(
        'out errors, out discards, FCS errors, fragments, collisions, runts, giants stayed at zero across the window.',
      ),
    ).toBeTruthy();
  });

  it('says the healthy sentence once when every counter stayed at zero', async () => {
    const keys = [
      'txBytes',
      'rxBytes',
      'inErrors',
      'outErrors',
      'inDiscards',
      'outDiscards',
      'inFcs',
      'inCrcErrors',
      'inFragmented',
      'outCollision',
      'inRunts',
      'inGiants',
    ];
    const startMs = Date.parse('2026-07-28T00:00:00.000Z');
    const cumulative = keys.map((_, i) => 1000 + i);
    const flat: SwitchInterfaceTrendsLive = {
      serial: 'sw-quiet',
      window: { start: '2026-07-28T00:00:00.000Z', end: '2026-07-29T00:00:00.000Z' },
      trends: normalizeTrendSet(
        keys,
        Array.from({ length: 24 }, (_v, hour) => ({
          timestamp: startMs + hour * 3_600_000,
          data: cumulative.map(String),
        })),
        interfaceTrendSpecs(keys),
      ),
      source: { plane: 'central', at: '2026-07-29T00:00:00.000Z', sections: { interfaces: 'ok' } },
    };
    mockSwitchReads({ kind: 'not-reported' }, { kind: 'ok', live: flat });
    render(<HardwareTrendsPanel name="sw-quiet" type="switch" identity={{ plane: 'CENTRAL' }} />);

    expect(
      await screen.findByText('All 10 reported error counters stayed at zero across the window.'),
    ).toBeTruthy();
    expect(screen.queryByText(/in the window$/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (e) the four read outcomes, worded four ways
// ---------------------------------------------------------------------------

describe('HardwareTrendsPanel — honest read outcomes', () => {
  it('not-reported says no plane answered, without implying the device has no telemetry', async () => {
    mockSwitchReads({ kind: 'not-reported' }, { kind: 'not-reported' });
    render(<HardwareTrendsPanel name="sw-x" type="switch" identity={{ plane: 'LOCAL' }} />);
    expect(
      await screen.findByText(
        'No hardware-trend read is available for this device — no claiming plane answered for it.',
      ),
    ).toBeTruthy();
  });

  it('a failed read names the failure, and a failed section names the plane note', async () => {
    mockSwitchReads(
      { kind: 'failed', message: 'HTTP 502' },
      {
        kind: 'ok',
        live: {
          ...IF,
          trends: undefined,
          source: { plane: 'central', at: IF.source.at, sections: { interfaces: 'failed' }, note: 'interface-trends: HTTP 503' },
        },
      },
    );
    render(<HardwareTrendsPanel name="sw-core-a" type="switch" identity={{ plane: 'CENTRAL' }} />);
    expect(await screen.findByText('Hardware trends could not be read — HTTP 502')).toBeTruthy();
    expect(
      screen.getByText('Interface counters could not be read — interface-trends: HTTP 503'),
    ).toBeTruthy();
  });

  it('an empty answer is not an error and not a chart of zeros', async () => {
    mockSwitchReads(
      {
        kind: 'ok',
        live: {
          ...HW,
          trends: { series: [], ok: false },
          source: { plane: 'central', at: HW.source.at, sections: { hardware: 'empty' } },
        },
      },
      { kind: 'not-reported' },
    );
    render(<HardwareTrendsPanel name="sw-core-a" type="switch" identity={{ plane: 'CENTRAL' }} />);
    expect(
      await screen.findByText('The plane answered with no usable hardware samples in this window.'),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (f) AP metrics
// ---------------------------------------------------------------------------

describe('HardwareTrendsPanel — Central AP', () => {
  it('renders cpu/memory/throughput with bit/s labels from three on-demand reads', async () => {
    mockApReads();
    render(<HardwareTrendsPanel name="ap-1f-04" type="ap" identity={{ plane: 'CENTRAL' }} />);

    // Latest samples: cpu 20%, memory 60%, throughput 162e9 bytes/h → 360 Mb/s.
    expect(await screen.findByText('20%')).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    expect(screen.getByText('360 Mb/s')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Throughput trend, 24 samples/ })).toBeTruthy();

    // One read per metric, each addressed to this AP.
    await waitFor(() => expect(mockApTrends).toHaveBeenCalledTimes(3));
    expect(mockApTrends.mock.calls.map((c) => c[1]).sort()).toEqual(['cpu', 'memory', 'throughput']);
    expect(mockApTrends.mock.calls[0]?.[0]).toBe('ap-1f-04');
  });

  it('words a broken metric read beside the ones that answered', async () => {
    mockApTrends.mockImplementation((_name, metric) =>
      metric === 'throughput'
        ? Promise.resolve({ kind: 'failed', message: 'HTTP 504' } as const)
        : Promise.resolve({ kind: 'ok', live: metric === 'cpu' ? AP_CPU : AP_MEM } as const),
    );
    render(<HardwareTrendsPanel name="ap-1f-04" type="ap" identity={{ plane: 'CENTRAL' }} />);
    expect(await screen.findByText('The throughput trend could not be read — HTTP 504')).toBeTruthy();
    expect(screen.getByRole('img', { name: /CPU trend/ })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (g) on-demand wiring
// ---------------------------------------------------------------------------

describe('HardwareTrendsPanel — on-demand wiring', () => {
  it('fetches once on mount with a 24h window, and re-fetches when the window changes', async () => {
    mockSwitchReads();
    render(<HardwareTrendsPanel name="sw-core-a" type="switch" identity={{ plane: 'CENTRAL', serial: 'CS1' }} />);
    await screen.findByText('87%');

    expect(mockHardware).toHaveBeenCalledTimes(1);
    const [name, window, identity] = mockHardware.mock.calls[0]!;
    expect(name).toBe('sw-core-a');
    expect(identity).toEqual({ plane: 'CENTRAL', serial: 'CS1' });
    expect(Date.parse(window.end) - Date.parse(window.start)).toBe(24 * 60 * 60_000);
    expect(mockInterfaces).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: '6h' }));
    await waitFor(() => expect(mockHardware).toHaveBeenCalledTimes(2));
    const next = mockHardware.mock.calls[1]![1];
    expect(Date.parse(next.end) - Date.parse(next.start)).toBe(6 * 60 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// (h) the pure helpers
// ---------------------------------------------------------------------------

describe('trend panel helpers', () => {
  it('rateText words bit/s as a rate', () => {
    expect(rateText(1_000_000_000)).toBe('1 Gb/s');
    expect(rateText(950_000_000)).toBe('950 Mb/s');
    expect(rateText(null)).toBeNull();
  });

  it('gapPhrase words the first hole between two samples, and ignores a counter’s leading null', () => {
    const cpu = HW.trends!.series[0]!;
    expect(gapPhrase([cpu])).toMatch(/^no samples \d{2}:\d{2}–\d{2}:\d{2}$/);
    // A counter series' first point is null BY CONSTRUCTION (no predecessor)
    // — not a coverage hole, and never worded as one.
    const tx = IF.trends!.series.find((s) => s.key === 'txBytes')!;
    expect(gapPhrase([tx])).toBeNull();
  });

  it('counterWindowTotal sums rate×Δt and refuses when no rate exists', () => {
    const crc = IF.trends!.series.find((s) => s.key === 'inCrcErrors')!;
    expect(counterWindowTotal(crc)).toBe(31);
    const out = IF.trends!.series.find((s) => s.key === 'outErrors')!;
    expect(counterWindowTotal(out)).toBe(0);
    const single = {
      key: 'inErrors',
      kind: 'counter' as const,
      rate: 'per-second' as const,
      bucketMs: 3_600_000,
      samples: 1,
      points: [{ t: '2026-07-28T00:00:00.000Z', v: null }],
    };
    expect(counterWindowTotal(single)).toBeNull();
  });
});
