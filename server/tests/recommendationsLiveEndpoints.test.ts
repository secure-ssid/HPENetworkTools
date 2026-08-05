/**
 * server/tests/recommendationsLiveEndpoints.test.ts — live recommendations must
 * not borrow the demo endpoint repository.
 *
 * ClearPass's endpoint read is explicitly best-effort: PlanePull documents it as
 * "never required for a healthy pull". So `cache.endpoints === undefined` is an
 * ordinary live state, not an error — and the route used to answer it with
 * CLEARPASS_ENDPOINTS, the authored demo repository.
 *
 * That is worse than an empty list. recommendationsForClient already discloses a
 * missing endpoint row: it marks the finding `evidence: 'partial'` and attaches
 * "Endpoint repository row not supplied to this evaluation". Handing it a
 * fixture row defeats the one mechanism built to report the gap — the finding is
 * stamped `evidence: 'observed'` and its detail asserts "ClearPass has seen the
 * MAC" about a plane that returned nothing.
 *
 * HPE_SETTINGS_PATH is set before the route module loads because the settings
 * singleton resolves its path at construction; the real data/settings.json is
 * never touched.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClientRow, EndpointRow } from '@hpe/shared';

const tmpDir = mkdtempSync(join(tmpdir(), 'hpe-recs-live-'));
process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
process.env.HPE_DATA_DIR = join(tmpDir, 'data');

let poller: typeof import('../src/services/poller').poller;
let settings: typeof import('../src/config/settings').settings;
let server: import('node:http').Server;
let base: string;

/** A MAC that exists in the authored repository — the collision that exposes
 *  the borrowed row. CLEARPASS_ENDPOINTS ep-001 is Dr. Okonjo's ward iPad. */
const FIXTURE_MAC = '3c:22:fb:41:0a:19';

beforeAll(async () => {
  const express = (await import('express')).default;
  const { recommendationsRouter } = await import('../src/routes/recommendations');
  ({ poller } = await import('../src/services/poller'));
  ({ settings } = await import('../src/config/settings'));
  const app = express();
  app.use('/api', recommendationsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((ready) => server.once('listening', () => ready()));
  const { port } = server.address() as import('node:net').AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done())));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** An uncategorized client: `type: 'unknown'` guarantees client.uncategorized
 *  fires, which is the rule that carries the endpoint evidence marking. */
function client(mac: string): ClientRow {
  return {
    name: 'unknown-endpoint-1',
    mac,
    type: 'unknown',
    model: 'unknown',
    site: 'Meridian Central',
    siteName: 'Meridian Central',
    siteId: 'meridian-central',
    plane: 'CLEARPASS',
    ip: '10.42.0.9',
    problem: false,
    health: 'good',
    auth: 'MAB',
    role: 'role Unclassified',
    // Only the fields the recommendation rules read are set; the rest of the
    // row is irrelevant to endpoint evidence.
  } as unknown as ClientRow;
}

function stubCache(endpoints: EndpointRow[] | undefined, clients: ClientRow[] = [client(FIXTURE_MAC)]) {
  vi.spyOn(poller, 'getCache').mockReturnValue({ devices: [], clients, endpoints } as never);
}

type Rec = { ruleId: string; evidence?: string; evidenceNote?: string; detail?: string };

/** The single uncategorized client this suite stubs into the live cache. */
async function uncategorizedRec(): Promise<Rec | undefined> {
  const res = await fetch(`${base}/api/recommendations?limit=200`);
  const body = (await res.json()) as { recommendations: Rec[] };
  return body.recommendations.find((r) => r.ruleId === 'client.uncategorized');
}

describe('live recommendations and the ClearPass endpoint repository', () => {
  it('does not borrow a demo endpoint row when the live repository was never read', async () => {
    settings.update({ demoMode: false });
    stubCache(undefined);

    const rec = await uncategorizedRec();
    expect(rec).toBeDefined();
    // The disclosure the rule engine already knew how to make.
    expect(rec?.evidence).toBe('partial');
    expect(rec?.evidenceNote).toBe('Endpoint repository row not supplied to this evaluation');
    // The claim a borrowed fixture row used to make about a silent plane.
    expect(rec?.detail).not.toContain('ClearPass has seen the MAC');
  });

  it('reports an empty live repository the same way as an unread one', async () => {
    settings.update({ demoMode: false });
    stubCache([]);

    const rec = await uncategorizedRec();
    expect(rec?.evidence).toBe('partial');
  });

  it('still says observed when the live repository really did carry the row', async () => {
    // The fix must not blind the engine to endpoint data that genuinely arrived.
    settings.update({ demoMode: false });
    stubCache([
      {
        id: 'ep-live-1',
        mac: FIXTURE_MAC,
        description: 'a row the operator\u2019s own ClearPass returned',
        ip: null,
        hostname: null,
        status: 'Known',
        category: null,
        family: null,
        os: null,
        profile: null,
        updatedAt: 'just now',
      } as EndpointRow,
    ]);

    const rec = await uncategorizedRec();
    expect(rec?.evidence).toBe('observed');
    expect(rec?.evidenceNote).toBeUndefined();
  });

  it('demo mode still reads the authored repository, not the live cache', async () => {
    // Guard in the other direction: demo must keep serving fixtures even when
    // the live cache is empty, or the demo estate would silently go blank.
    settings.update({ demoMode: true });
    stubCache([], []);

    const res = await fetch(`${base}/api/recommendations?limit=200`);
    const body = (await res.json()) as { recommendations: Rec[]; counts: { total: number } };
    expect(body.counts.total).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });
});
