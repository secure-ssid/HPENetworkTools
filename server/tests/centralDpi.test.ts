/**
 * server/tests/centralDpi.test.ts — the Central adapter's on-demand DPI
 * application and hardware-trend readers, NO network.
 *
 * Same harness as central.test.ts: an in-memory fake fetch (FetchLike
 * injection), recorded outbound calls, injected sleeps and clock. The shapes
 * fed back are the verified endpoint envelopes: applications rows with their
 * dead fields, hardware-trends' positional keys+samples, the AP
 * trends.graph envelope with ISO timestamps, and interface-trends' response
 * envelope of cumulative counters.
 */

import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { ApTrendMetric } from '@hpe/shared';
import { CentralAdapter } from '../src/planes/central';
import type { FetchLike } from '../src/planes/transport';

// -- Harness (mirrors central.test.ts) ---------------------------------------

type HandlerResult = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (method: string, pathname: string, query: URLSearchParams) => HandlerResult | undefined;

function fakeFetch(handler: Handler): { fn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init?.method as string | undefined) ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    const result = handler(method, u.pathname, u.searchParams);
    if (!result) {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    });
  };
  return { fn, calls };
}

function makeState(): PlaneState {
  return { id: 'central', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { gatewayBaseUrl: 'https://apigw-prod2.central.arubanetworks.com', clientId: 'id-1', clientSecret: 'shh-secret' };
const NEW_CREDS = { gatewayBaseUrl: 'https://us1.api.central.arubanetworks.com', clientId: 'id-1', clientSecret: 'shh-secret' };

function makeDetailAdapter(handler: Handler, clock: { ms: number } = { ms: Date.parse('2026-07-28T16:00:00Z') }) {
  const { fn, calls } = fakeFetch(handler);
  const recorded: { path: string; ms: number; code: string }[] = [];
  const state = makeState();
  const slept: number[] = [];
  const adapter = new CentralAdapter(
    CREDS,
    state,
    (c) => recorded.push(c),
    fn,
    async (ms) => {
      slept.push(ms);
    },
    () => clock.ms,
  );
  return { adapter, state, recorded, calls, slept, clock };
}

function makeNewAdapter(handler: Handler) {
  const { fn, calls } = fakeFetch(handler);
  const state = makeState();
  const slept: number[] = [];
  const adapter = new CentralAdapter(NEW_CREDS, state, () => {}, fn, async (ms) => {
    slept.push(ms);
  });
  return { adapter, state, calls, slept };
}

// -- Recorded payloads --------------------------------------------------------

const WINDOW = { start: '2026-07-27T12:00:00.000Z', end: '2026-07-28T12:00:00.000Z' };
const WIDE_WINDOW = { start: '2026-07-14T12:00:00.000Z', end: '2026-07-28T12:00:00.000Z' }; // 14 days
const T0 = Date.parse('2026-07-28T08:00:00.000Z');

const APP_MS365 = {
  name: 'Microsoft 365', id: 'app-0365', risk: 'trusted', state: 'active',
  rxBytes: '4230000000', txBytes: '810000000', categories: ['Collaboration', 'Web'],
  applicationHostType: 'cloud', destLocation: ['US'], experience: 0,
  lastUsedTime: String(T0), tlsVersion: '', certificateExpiryDate: '',
};
const APP_UNK = {
  name: 'unknown-tcp-4410', id: 'app-unk', risk: 'medium', state: 'active',
  rxBytes: '410000000', txBytes: '38000000', categories: ['unknown'],
  applicationHostType: null, destLocation: [], experience: 0,
  lastUsedTime: String(T0), tlsVersion: '', certificateExpiryDate: '',
};
const APP_YT = {
  name: 'YouTube', id: 'app-yt', risk: 'low', state: 'active',
  rxBytes: '2890000000', txBytes: '120000000', categories: ['Streaming', 'Web'],
  applicationHostType: 'cloud', destLocation: ['US'], experience: 0,
  lastUsedTime: String(T0), tlsVersion: '', certificateExpiryDate: '',
};

const HW_KEYS = [
  'cpuUtilization', 'memoryUtilization', 'systemTemperature',
  'poeAvailable', 'poeConsumption', 'powerConsumption', 'totalPowerConsumption',
];

/** Four hourly samples with a 3-hour hole before the last one (an outage). */
const HW_BODY = {
  keys: HW_KEYS,
  samples: [
    { timestamp: T0, data: ['14', '39', '41.5', '370', '178', '208', '392'] },
    { timestamp: T0 + 3_600_000, data: ['15', '40', '42.0', '370', '180', '210', '396'] },
    { timestamp: T0 + 2 * 3_600_000, data: ['16', '41', '42.4', '370', '181', '211', '398'] },
    { timestamp: T0 + 5 * 3_600_000, data: ['17', '42', '42.9', '370', '182', '212', '400'] },
  ],
};

const AP_CPU_BODY = {
  trends: {
    graph: {
      keys: ['cpuUtilization'],
      samples: [
        { timestamp: '2026-07-28T08:00:00.000Z', data: ['18'] },
        { timestamp: '2026-07-28T08:05:00.000Z', data: ['19'] },
      ],
    },
  },
};

const AP_THROUGHPUT_BODY = {
  trends: {
    graph: {
      keys: ['throughput'],
      samples: [
        { timestamp: '2026-07-28T08:00:00.000Z', data: ['360000000'] },
        { timestamp: '2026-07-28T08:05:00.000Z', data: ['720000000'] },
      ],
    },
  },
};

const IF_BODY = {
  response: {
    keys: ['txBytes', 'inErrors', 'futureGauge'],
    samples: [
      { timestamp: T0, data: ['8000', '800', '51'] },
      { timestamp: T0 + 60_000, data: ['14000', '1400', '52'] },
      { timestamp: T0 + 120_000, data: ['20000', '2000', '49'] },
    ],
  },
};

/** Handler for the recorded endpoints; unknown paths 404 as usual. */
function dpiHandler(overrides: Record<string, HandlerResult> = {}): Handler {
  return (method, pathname) => {
    const decoded = decodeURIComponent(pathname);
    for (const [frag, result] of Object.entries(overrides)) {
      if (decoded.includes(frag)) return result;
    }
    if (method === 'POST' && pathname === '/oauth2/token') return { body: { access_token: 'tok-1', expires_in: 7200 } };
    if (pathname === '/network-monitoring/v1/applications') {
      return { body: { applications: [APP_MS365, APP_UNK, APP_YT], total: 3 } };
    }
    if (pathname.endsWith('/hardware-trends')) return { body: HW_BODY };
    if (pathname.includes('/aps/') && pathname.endsWith('/throughput-trends')) return { body: AP_THROUGHPUT_BODY };
    if (pathname.includes('/aps/') && pathname.endsWith('/cpu-trends')) return { body: AP_CPU_BODY };
    if (pathname.endsWith('/interface-trends')) return { body: IF_BODY };
    return undefined;
  };
}

// -- siteApplications ---------------------------------------------------------

describe('CentralAdapter.siteApplications()', () => {
  it('sends the required params, ranks the table by bytes and folds the risk aliases', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    const d = (await adapter.siteApplications('campus-01', WINDOW))!;
    expect(d.siteId).toBe('campus-01');
    expect(d.source.plane).toBe('central');
    expect(d.source.sections).toEqual({ apps: 'ok' });
    expect(d.source.note).toBeNull();
    expect(d.window).toEqual(WINDOW); // canonicalized bounds echoed back

    const call = calls.find((c) => c.includes('/applications'))!;
    const decoded = decodeURIComponent(call);
    expect(decoded).toContain('site_id=campus-01');
    expect(decoded).toContain('start=2026-07-27T12:00:00.000Z');
    expect(decoded).toContain('end=2026-07-28T12:00:00.000Z');
    expect(call).toContain('limit=200');
    expect(call).toContain('offset=0');

    // Ranked by total bytes, not by wire order: YouTube outranks unknown-tcp.
    expect(d.apps!.map((a) => a.name)).toEqual(['Microsoft 365', 'YouTube', 'unknown-tcp-4410']);
    const [ms365, , unk] = d.apps!;
    expect(ms365.riskRaw).toBe('trusted');
    expect(ms365.risk).toBe('trustworthy');
    expect(ms365.totalBytes).toBe(5_040_000_000);
    expect(unk.risk).toBe('moderate');
    // The verified dead fields arrive as nulls, never as data.
    expect(ms365.experience).toBeNull();
    expect(ms365.tlsVersion).toBeNull();
    expect(ms365.certificateExpiryAt).toBeNull();
    expect(d.truncated).toBeUndefined();
  });

  it('walks offset pages until a short page and merges the rows', async () => {
    const pageOne = Array.from({ length: 200 }, (_, i) => ({
      name: `app-${String(i).padStart(3, '0')}`, id: `app-${i}`, risk: 'low',
      rxBytes: String(1_000_000 + i), txBytes: '0', categories: ['Web'],
    }));
    const paged: Handler = (method, pathname, query) => {
      if (method === 'POST' && pathname === '/oauth2/token') return { body: { access_token: 'tok-1', expires_in: 7200 } };
      if (pathname === '/network-monitoring/v1/applications') {
        const offset = Number(query.get('offset') ?? '0');
        if (offset === 0) return { body: { applications: pageOne, total: 201 } };
        if (offset === 200) return { body: { applications: [APP_UNK], total: 201 } };
        return { body: { applications: [], total: 201 } };
      }
      return undefined;
    };
    const { adapter, calls } = makeDetailAdapter(paged);
    const d = (await adapter.siteApplications('campus-01', WINDOW))!;
    expect(d.apps).toHaveLength(201);
    expect(d.truncated).toBeUndefined();
    const appCalls = calls.filter((c) => c.includes('/applications'));
    expect(appCalls).toHaveLength(2);
    expect(appCalls[0]).toContain('offset=0');
    expect(appCalls[1]).toContain('offset=200');
  });

  it('marks the table truncated when the plane states a total it never hands over', async () => {
    const pageOne = Array.from({ length: 200 }, (_, i) => ({
      name: `app-${i}`, id: `app-${i}`, risk: 'low', rxBytes: '1000', txBytes: '0', categories: ['Web'],
    }));
    const paged: Handler = (method, pathname, query) => {
      if (method === 'POST' && pathname === '/oauth2/token') return { body: { access_token: 'tok-1', expires_in: 7200 } };
      if (pathname === '/network-monitoring/v1/applications') {
        const offset = Number(query.get('offset') ?? '0');
        // The endpoint claims 500 but the second page comes back empty.
        return { body: { applications: offset === 0 ? pageOne : [], total: 500 } };
      }
      return undefined;
    };
    const { adapter } = makeDetailAdapter(paged);
    const d = (await adapter.siteApplications('campus-01', WINDOW))!;
    expect(d.apps).toHaveLength(200);
    expect(d.truncated).toBe(true);
    expect(d.source.sections.apps).toBe('ok');
    expect(d.source.note).toContain('prefix');
  });

  it('keeps the rows and says truncated when a MID-WALK page fails', async () => {
    const pageOne = Array.from({ length: 200 }, (_, i) => ({
      name: `app-${i}`, id: `app-${i}`, risk: 'low', rxBytes: '1000', txBytes: '0', categories: ['Web'],
    }));
    const paged: Handler = (method, pathname, query) => {
      if (method === 'POST' && pathname === '/oauth2/token') return { body: { access_token: 'tok-1', expires_in: 7200 } };
      if (pathname === '/network-monitoring/v1/applications') {
        const offset = Number(query.get('offset') ?? '0');
        if (offset === 0) return { body: { applications: pageOne, total: 500 } };
        return { status: 500, body: {} };
      }
      return undefined;
    };
    const { adapter } = makeDetailAdapter(paged);
    const d = (await adapter.siteApplications('campus-01', WINDOW))!;
    expect(d.apps).toHaveLength(200); // the page that answered still ships
    expect(d.truncated).toBe(true);
    expect(d.source.sections.apps).toBe('ok');
    expect(d.source.note).toContain('prefix');
  });

  it('refuses a wider-than-7d window BEFORE spending a call — not-fetched, not failed', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    const d = (await adapter.siteApplications('campus-01', WIDE_WINDOW))!;
    expect(d.apps).toBeUndefined();
    expect(d.source.sections).toEqual({}); // we chose not to ask
    expect(d.source.note).toContain('wider than 7');
    expect(calls.filter((c) => c.includes('/applications'))).toHaveLength(0);
  });

  it('a 400 on page one is failed with the plane answer in the note', async () => {
    const { adapter } = makeDetailAdapter(dpiHandler({ '/applications': { status: 400, body: { error: 'window too wide' } } }));
    const d = (await adapter.siteApplications('campus-01', WINDOW))!;
    expect(d.apps).toBeUndefined();
    expect(d.source.sections.apps).toBe('failed');
    expect(d.source.note).toContain('HTTP 400');
  });

  it('an authoritative empty table is empty, not failed', async () => {
    const { adapter } = makeDetailAdapter(dpiHandler({ '/applications': { body: { applications: [], total: 0 } } }));
    const d = (await adapter.siteApplications('campus-01', WINDOW))!;
    expect(d.apps).toEqual([]);
    expect(d.source.sections.apps).toBe('empty');
    expect(d.source.note).toBeNull();
  });

  it('a 200 with no readable rows is failed, not an empty table', async () => {
    const { adapter } = makeDetailAdapter(dpiHandler({ '/applications': { body: { message: 'try again shortly' } } }));
    const d = (await adapter.siteApplications('campus-01', WINDOW))!;
    expect(d.apps).toBeUndefined();
    expect(d.source.sections.apps).toBe('failed');
    expect(d.source.note).toContain('no readable rows');
  });

  it('a blank site id is answered with null and costs no call', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    expect(await adapter.siteApplications('  ', WINDOW)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('resolves the native site id remembered during pull, like topology', async () => {
    const nativeSiteId = '79244870000394240';
    const { adapter, calls } = makeNewAdapter((method, pathname) => {
      if (method === 'POST' && pathname === '/as/token.oauth2') {
        return { body: { access_token: 'new-token', expires_in: 7200 } };
      }
      if (method === 'GET' && pathname === '/network-monitoring/v1/device-inventory') {
        return { body: { devices: [], next: null } };
      }
      if (method === 'GET' && pathname === '/network-config/v1/sites') {
        return { body: { items: [{ scopeName: 'SecureSSID', scopeId: nativeSiteId }] } };
      }
      if (method === 'GET' && pathname === '/network-monitoring/v1/clients') {
        return { body: { items: [], next: null } };
      }
      if (method === 'GET' && pathname === '/network-notifications/v1/alerts') {
        return { body: { items: [], next: null } };
      }
      if (method === 'GET' && pathname === '/network-config/v1/wlan-ssids') {
        return { body: { 'wlan-ssid': [] } };
      }
      if (method === 'GET' && pathname === '/network-monitoring/v1/applications') {
        return { body: { applications: [APP_MS365], total: 1 } };
      }
      return undefined;
    });
    await adapter.pull();
    const d = (await adapter.siteApplications('SecureSSID', WINDOW))!;
    expect(d.apps).toHaveLength(1);
    const appCall = calls.find((c) => c.includes('/applications'))!;
    expect(decodeURIComponent(appCall)).toContain(`site_id=${nativeSiteId}`);
    expect(decodeURIComponent(appCall)).not.toContain('site_id=SecureSSID');
  });

  it('caches the read within its TTL and says so', async () => {
    const clock = { ms: Date.parse('2026-07-28T16:00:00Z') };
    const { adapter, calls } = makeDetailAdapter(dpiHandler(), clock);
    await adapter.siteApplications('campus-01', WINDOW);
    expect(calls.filter((c) => c.includes('/applications'))).toHaveLength(1);
    const again = (await adapter.siteApplications('campus-01', WINDOW))!;
    expect(calls.filter((c) => c.includes('/applications'))).toHaveLength(1);
    expect(again.source.cached).toBe(true);
    clock.ms += 60_000; // past the 45s detail TTL
    const fresh = (await adapter.siteApplications('campus-01', WINDOW))!;
    expect(calls.filter((c) => c.includes('/applications'))).toHaveLength(2);
    expect(fresh.source.cached).toBe(false);
  });
});

// -- switchHardwareTrends -----------------------------------------------------

describe('CentralAdapter.switchHardwareTrends()', () => {
  it('reads the seven gauge series and breaks the line across the outage', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    const d = (await adapter.switchHardwareTrends('SG30LMR164', WINDOW))!;
    expect(d.serial).toBe('SG30LMR164');
    expect(d.source.sections).toEqual({ hardware: 'ok' });
    expect(d.source.note).toBeNull();

    const call = calls.find((c) => c.includes('/hardware-trends'))!;
    expect(call).toContain('/network-monitoring/v1/switches/SG30LMR164/hardware-trends');
    // Only the applications endpoint is verified to take start/end — the
    // trend call goes out bare rather than risking a 400 on a strict gateway.
    expect(call).not.toContain('start=');
    expect(call).not.toContain('end=');

    const set = d.trends!;
    expect(set.ok).toBe(true);
    expect(set.series.map((s) => s.key)).toEqual(HW_KEYS);
    const cpu = set.series[0];
    expect(cpu.kind).toBe('gauge');
    expect(cpu.rate).toBeNull();
    expect(cpu.bucketMs).toBe(3_600_000); // median delta, detected
    expect(cpu.points).toEqual([
      { t: new Date(T0).toISOString(), v: 14 },
      { t: new Date(T0 + 3_600_000).toISOString(), v: 15 },
      { t: new Date(T0 + 2 * 3_600_000).toISOString(), v: 16 },
      { t: new Date(T0 + 3 * 3_600_000).toISOString(), v: null }, // the gap marker
      { t: new Date(T0 + 5 * 3_600_000).toISOString(), v: 17 },
    ]);
    const temp = set.series[2];
    expect(temp.points[0].v).toBe(41.5); // string parsed
  });

  it('a 404 is failed with the note, never an empty chart', async () => {
    const { adapter } = makeDetailAdapter(dpiHandler({ '/hardware-trends': { status: 404, body: {} } }));
    const d = (await adapter.switchHardwareTrends('SG30LMR164', WINDOW))!;
    expect(d.trends).toBeUndefined();
    expect(d.source.sections.hardware).toBe('failed');
    expect(d.source.note).toContain('HTTP 404');
  });

  it('a 200 with no readable trend graph is failed, not empty', async () => {
    const { adapter } = makeDetailAdapter(dpiHandler({ '/hardware-trends': { body: { message: 'try again shortly' } } }));
    const d = (await adapter.switchHardwareTrends('SG30LMR164', WINDOW))!;
    expect(d.trends).toBeUndefined();
    expect(d.source.sections.hardware).toBe('failed');
    expect(d.source.note).toContain('no readable trend graph');
  });

  it('a payload with no usable samples is empty, honestly', async () => {
    const { adapter } = makeDetailAdapter(dpiHandler({ '/hardware-trends': { body: { keys: HW_KEYS, samples: [] } } }));
    const d = (await adapter.switchHardwareTrends('SG30LMR164', WINDOW))!;
    expect(d.trends!.ok).toBe(false);
    expect(d.source.sections.hardware).toBe('empty');
    expect(d.source.note).toBeNull();
  });

  it('refuses a wider-than-7d window before spending a call', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    const d = (await adapter.switchHardwareTrends('SG30LMR164', WIDE_WINDOW))!;
    expect(d.trends).toBeUndefined();
    expect(d.source.sections).toEqual({});
    expect(d.source.note).toContain('wider than 7');
    expect(calls.filter((c) => c.includes('/hardware-trends'))).toHaveLength(0);
  });

  it('a blank serial is answered with null and costs no call', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    expect(await adapter.switchHardwareTrends('', WINDOW)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('caches per serial within the TTL', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    await adapter.switchHardwareTrends('SG30LMR164', WINDOW);
    const again = (await adapter.switchHardwareTrends('SG30LMR164', WINDOW))!;
    expect(calls.filter((c) => c.includes('/hardware-trends'))).toHaveLength(1);
    expect(again.source.cached).toBe(true);
  });
});

// -- apTrends -----------------------------------------------------------------

describe('CentralAdapter.apTrends()', () => {
  it('converts throughput bytes-per-bucket to bit/s using the detected bucket width', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    const d = (await adapter.apTrends('PHT5M520SZ', 'throughput', WINDOW))!;
    expect(calls.some((c) => c.includes('/aps/PHT5M520SZ/throughput-trends'))).toBe(true);
    expect(d.source.sections).toEqual({ trends: 'ok' });
    const series = d.trends!.series[0];
    expect(series.kind).toBe('bucket-total');
    expect(series.rate).toBe('bits-per-second');
    expect(series.bucketMs).toBe(300_000);
    // 3.6e8 bytes over 300s = 9.6e6 bit/s; 7.2e8 → 1.92e7
    expect(series.points[0].v).toBeCloseTo(9_600_000, 6);
    expect(series.points[1].v).toBeCloseTo(19_200_000, 6);
  });

  it('cpu is a gauge pass-through', async () => {
    const { adapter } = makeDetailAdapter(dpiHandler());
    const d = (await adapter.apTrends('PHT5M520SZ', 'cpu', WINDOW))!;
    const series = d.trends!.series[0];
    expect(series.kind).toBe('gauge');
    expect(series.rate).toBeNull();
    expect(series.points.map((p) => p.v)).toEqual([18, 19]);
  });

  it('a metric outside the endpoint vocabulary answers null and costs no call', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    expect(await adapter.apTrends('PHT5M520SZ', 'bogus' as ApTrendMetric, WINDOW)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a 404 is failed with the note', async () => {
    const { adapter } = makeDetailAdapter(dpiHandler({ '/cpu-trends': { status: 404, body: {} } }));
    const d = (await adapter.apTrends('PHT5M520SZ', 'cpu', WINDOW))!;
    expect(d.trends).toBeUndefined();
    expect(d.source.sections.trends).toBe('failed');
    expect(d.source.note).toContain('HTTP 404');
  });

  it('tolerates a bare keys+samples envelope as well as trends.graph', async () => {
    const { adapter } = makeDetailAdapter(
      dpiHandler({ '/cpu-trends': { body: AP_CPU_BODY.trends.graph } }),
    );
    const d = (await adapter.apTrends('PHT5M520SZ', 'cpu', WINDOW))!;
    expect(d.source.sections.trends).toBe('ok');
    expect(d.trends!.series[0].points.map((p) => p.v)).toEqual([18, 19]);
  });

  it('a blank serial is answered with null and costs no call', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    expect(await adapter.apTrends(' ', 'cpu', WINDOW)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

// -- switchInterfaceTrends ----------------------------------------------------

describe('CentralAdapter.switchInterfaceTrends()', () => {
  it('differentiates the counters into rates and leaves unknown keys as gauges', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    const d = (await adapter.switchInterfaceTrends('SG30LMR164', WINDOW))!;
    expect(calls.some((c) => c.includes('/network-monitoring/v1/switches/SG30LMR164/interface-trends'))).toBe(true);
    expect(d.source.sections).toEqual({ interfaces: 'ok' });

    const [tx, inErrors, gauge] = d.trends!.series;
    expect(tx.kind).toBe('counter');
    expect(tx.rate).toBe('bits-per-second');
    // (14000-8000) bytes over 60s = 100 B/s = 800 bit/s
    expect(tx.points.map((p) => p.v)).toEqual([null, 800, 800]);
    expect(inErrors.kind).toBe('counter');
    expect(inErrors.rate).toBe('per-second');
    expect(inErrors.points.map((p) => p.v)).toEqual([null, 10, 10]);
    // A key the spec does not know stays a gauge — never a fabricated rate.
    expect(gauge.kind).toBe('gauge');
    expect(gauge.points.map((p) => p.v)).toEqual([51, 52, 49]);
  });

  it('a counter reset is a hole, never a negative rate', async () => {
    const resetBody = {
      response: {
        keys: ['inErrors'],
        samples: [
          { timestamp: T0, data: ['800'] },
          { timestamp: T0 + 60_000, data: ['1400'] },
          { timestamp: T0 + 120_000, data: ['100'] }, // the reboot
        ],
      },
    };
    const { adapter } = makeDetailAdapter(dpiHandler({ '/interface-trends': { body: resetBody } }));
    const d = (await adapter.switchInterfaceTrends('SG30LMR164', WINDOW))!;
    expect(d.trends!.series[0].points.map((p) => p.v)).toEqual([null, 10, null]);
  });

  it('a 404 is failed with the note', async () => {
    const { adapter } = makeDetailAdapter(dpiHandler({ '/interface-trends': { status: 404, body: {} } }));
    const d = (await adapter.switchInterfaceTrends('SG30LMR164', WINDOW))!;
    expect(d.trends).toBeUndefined();
    expect(d.source.sections.interfaces).toBe('failed');
    expect(d.source.note).toContain('HTTP 404');
  });

  it('a blank serial is answered with null and costs no call', async () => {
    const { adapter, calls } = makeDetailAdapter(dpiHandler());
    expect(await adapter.switchInterfaceTrends('', WINDOW)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

// -- these reads are not poller work -------------------------------------------

describe('DPI/trend reads are not poller work', () => {
  it('pull() never issues an applications or trends call', async () => {
    const routes: Record<string, unknown> = {
      'POST /oauth2/token': { access_token: 'tok-1', expires_in: 7200 },
      'GET /monitoring/v1/aps': { aps: [], total: 0 },
      'GET /monitoring/v1/switches': { switches: [], total: 0 },
      'GET /monitoring/v1/gateways': { gateways: [], total: 0 },
      'GET /central/v2/sites': { sites: [], total: 0 },
      'GET /monitoring/v1/clients': { clients: [], total: 0 },
      'GET /central/v1/notifications': { notifications: [], total: 0 },
    };
    const { fn, calls } = fakeFetch((method, pathname) => {
      const body = routes[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    const adapter = new CentralAdapter(CREDS, makeState(), () => {}, fn, async () => {});
    await adapter.pull();
    // One fan-out over the inventory per poll would be the regression this
    // whole design exists to prevent.
    for (const fragment of ['/applications', '-trends']) {
      expect(calls.some((c) => c.includes(fragment))).toBe(false);
    }
  });
});
