/**
 * server/src/routes/systems.ts — live plane state, connection tests, credentials.
 *
 *   GET    /api/systems/state              registry truth + poller sync history
 *   POST   /api/systems/sync               immediately poll every linked plane
 *   POST   /api/systems/:plane/test        real connection test (see below)
 *   POST   /api/systems/:plane/credentials save creds, re-init the adapter
 *   DELETE /api/systems/:plane             clear creds, adapter becomes unlinked
 *
 * Connection tests are honest: for 'central' we attempt a real OAuth
 * client-credentials token fetch (GreenLake SSO for new-Central gateways,
 * the gateway's own /oauth2/token for classic — host shape decides, 8s) and,
 * if a token comes back, a best-effort device sample query. 'uxi' gets the
 * same treatment against HPE SSO (Basic client-credentials → token.oauth2,
 * then a sensor roster sample). For other planes we only prove reachability
 * (HTTP GET when the endpoint has a scheme, TCP connect for bare host[:port],
 * 5s) and say exactly that — "credentials not yet validated". Every attempt
 * is recorded in the plane's API-call log.
 *
 * Test-then-save: when the request body carries a complete credential set for
 * the plane, THOSE are tested (the connect flow tests before saving); only
 * otherwise do we fall back to the stored credentials. 400 when neither
 * exists. The result's `source` field says which set was exercised.
 */

import * as net from 'node:net';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { settings } from '../config/settings';
import { CentralAdapter, GREENLAKE_CCS_TOKEN_URL, isNewCentralGateway } from '../planes/central';
import { UxiAdapter } from '../planes/uxi';
import { registry } from '../planes/registry';
import { poller } from '../services/poller';
import { PLANE_IDS, type PlaneId } from '../planes/types';

export const systemsRouter = Router();

/** Wrap async handlers so rejections reach the error middleware (Express 4). */
function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function asPlaneId(value: string): PlaneId | null {
  return (PLANE_IDS as readonly string[]).includes(value) ? (value as PlaneId) : null;
}

// -- Live state ----------------------------------------------------------------

systemsRouter.get('/systems/state', (_req, res) => {
  const states = registry.states();
  const planes = {} as Record<PlaneId, unknown>;
  for (const id of PLANE_IDS) {
    planes[id] = { ...states[id], recentCalls: registry.recentCalls(id) };
  }
  res.json({
    dataSource: 'live',
    syncedAt: poller.lastSyncAny(),
    demoMode: settings.get().demoMode,
    planes,
    history: poller.history(),
  });
});

systemsRouter.post(
  '/systems/sync',
  h(async (_req, res) => {
    const result = await poller.syncNow();
    const started = [...result.synced, ...result.failed];
    res.json({
      ok: result.failed.length === 0,
      started,
      ...(result.failed.length > 0 ? { failed: result.failed } : {}),
      ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
    });
  }),
);

// -- Connection test -----------------------------------------------------------

interface TestResult {
  ok: boolean;
  plane: PlaneId;
  message: string;
  ms: number;
  source: 'request' | 'stored';
}

/** Keep only non-empty string entries from an untrusted credential record. */
function sanitizeCreds(input: unknown): Record<string, string> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim().length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Credential keys that name a host/endpoint — what a reachability test can actually exercise. */
const HOST_KEYS = ['host', 'baseUrl', 'url', 'endpoint', 'jumpHost', 'address', 'master', 'publisher', 'apiHost'];

/**
 * Is this credential set complete enough to test on its own? Central needs
 * the full OAuth trio; other planes need at least one host-ish field for the
 * reachability check to have something real to try.
 */
function completeCredsFor(plane: PlaneId, creds: Record<string, string> | null): boolean {
  if (!creds) return false;
  if (plane === 'central') return CentralAdapter.isComplete(creds);
  if (plane === 'uxi') return UxiAdapter.isComplete(creds);
  return HOST_KEYS.some((k) => typeof creds[k] === 'string' && creds[k].trim().length > 0);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<globalThis.Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

function tcpCheck(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => sock.destroy(new Error(`no response within ${timeoutMs}ms`)), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve();
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function withScheme(base: string): string {
  return /^https?:\/\//i.test(base) ? base : `https://${base}`;
}

/** HPE Aruba Networking Central: real OAuth client-credentials token fetch.
 *  New-Central gateways ({region}.api.central…) are minted by GreenLake SSO;
 *  classic *-apigw* gateways mint their own /oauth2/token — host shape picks
 *  the order, a 404 crosses over once (same rule as the adapter). */
async function testCentral(creds: Record<string, string>): Promise<Omit<TestResult, 'plane' | 'ms' | 'source'>> {
  const base = creds.gatewayBaseUrl?.replace(/\/+$/, '');
  if (!base || !creds.clientId || !creds.clientSecret) {
    return { ok: false, message: 'central requires gatewayBaseUrl, clientId and clientSecret' };
  }
  const baseUrl = withScheme(base);
  const sso = { url: GREENLAKE_CCS_TOKEN_URL, label: 'GreenLake SSO' };
  const local = { url: `${baseUrl}/oauth2/token`, label: 'gateway /oauth2/token' };
  const candidates = isNewCentralGateway(baseUrl) ? [sso, local] : [local, sso];

  let token: string | null = null;
  let mintedBy = '';
  let lastMiss = '';
  for (const ep of candidates) {
    let tokenRes: globalThis.Response;
    try {
      tokenRes = await fetchWithTimeout(
        ep.url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
          }).toString(),
        },
        8000,
      );
    } catch (err) {
      // A network failure on the primary says nothing about the other
      // generation — report it, don't spray credentials at a second host.
      return { ok: false, message: `token request to ${ep.label} failed: ${(err as Error).message}` };
    }
    if (tokenRes.status === 404) {
      lastMiss = `${ep.label} answered 404`;
      continue; // wrong generation for this account — try the other
    }
    if (!tokenRes.ok) {
      return { ok: false, message: `${ep.label} answered HTTP ${tokenRes.status} — credentials rejected` };
    }
    try {
      const body = (await tokenRes.json()) as Record<string, unknown>;
      token = typeof body.access_token === 'string' ? body.access_token : null;
    } catch {
      /* fall through */
    }
    if (!token) {
      return { ok: false, message: `${ep.label} answered 200 but no access_token in the body` };
    }
    mintedBy = ep.label;
    break;
  }
  if (!token) {
    return { ok: false, message: lastMiss || 'no token endpoint answered' };
  }

  // Best-effort: report what a lightweight device query finds. Same fallback
  // order as the poller — classic monitoring first, new-Central v1alpha1 on
  // a 404 — so the message names the generation that actually answers.
  const sampleCandidates = ['/monitoring/v1/aps', '/network-monitoring/v1alpha1/aps'];
  let lastStatus: number | null = null;
  for (const path of sampleCandidates) {
    try {
      const sampleRes = await fetchWithTimeout(
        `${baseUrl}${path}?limit=1`,
        { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
        5000,
      );
      if (sampleRes.status === 404 && path !== sampleCandidates[sampleCandidates.length - 1]) {
        lastStatus = 404;
        continue; // wrong generation for this workspace — try the next
      }
      if (!sampleRes.ok) {
        return { ok: true, message: `authenticated via ${mintedBy} — token received; device sample query answered HTTP ${sampleRes.status}` };
      }
      const body = (await sampleRes.json()) as unknown;
      const count = Array.isArray(body)
        ? `${body.length}+`
        : typeof (body as Record<string, unknown>).count === 'number'
          ? String((body as Record<string, unknown>).count)
          : 'unknown';
      const generation = path.includes('v1alpha1') ? 'new Central' : 'classic';
      return { ok: true, message: `authenticated via ${mintedBy} — token received; ${generation} device sample ok, reported AP count: ${count}` };
    } catch (err) {
      return { ok: true, message: `authenticated via ${mintedBy} — token received; device sample query failed: ${(err as Error).message}` };
    }
  }
  return { ok: true, message: `authenticated via ${mintedBy} — token received; device sample query answered HTTP ${lastStatus ?? 404} on every known path` };
}

/** HPE Aruba UXI: real SSO Basic client-credentials token fetch. */
async function testUxi(creds: Record<string, string>): Promise<Omit<TestResult, 'plane' | 'ms' | 'source'>> {
  if (!UxiAdapter.isComplete(creds)) {
    return { ok: false, message: 'uxi requires clientId and clientSecret' };
  }
  const tokenUrl = 'https://sso.common.cloud.hpe.com/as/token.oauth2';
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  let tokenRes: globalThis.Response;
  try {
    tokenRes = await fetchWithTimeout(
      tokenUrl,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      },
      8000,
    );
  } catch (err) {
    return { ok: false, message: `token request to ${tokenUrl} failed: ${(err as Error).message}` };
  }
  if (!tokenRes.ok) {
    return { ok: false, message: `SSO token endpoint answered HTTP ${tokenRes.status} — client credentials rejected` };
  }
  let token: string | null = null;
  try {
    const body = (await tokenRes.json()) as Record<string, unknown>;
    token = typeof body.access_token === 'string' ? body.access_token : null;
  } catch {
    /* fall through */
  }
  if (!token) {
    return { ok: false, message: 'SSO token endpoint answered 200 but no access_token in the body' };
  }

  // Best-effort: report what the sensor roster query finds.
  const base = (creds.baseUrl?.trim() || 'https://api.capenetworks.com').replace(/\/+$/, '');
  try {
    const sampleRes = await fetchWithTimeout(
      `${base}/networking-uxi/v1alpha1/sensors`,
      { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
      5000,
    );
    if (!sampleRes.ok) {
      return { ok: true, message: `authenticated — token received; sensor roster query answered HTTP ${sampleRes.status}` };
    }
    const body = (await sampleRes.json()) as Record<string, unknown>;
    const items = Array.isArray(body.items) ? body.items.length : null;
    const count = typeof body.count === 'number' ? body.count : items;
    return {
      ok: true,
      message: `authenticated — token received; sensor roster ok, reported sensors: ${count ?? 'unknown'}`,
    };
  } catch (err) {
    return { ok: true, message: `authenticated — token received; sensor roster query failed: ${(err as Error).message}` };
  }
}

/** Generic planes: reachability only, reported honestly. */
async function testReachable(plane: PlaneId, creds: Record<string, string>): Promise<Omit<TestResult, 'plane' | 'ms' | 'source'>> {
  // Only a host-ish field may name a target — any other stored value (token,
  // password, …) must never be dialed, and never echoed back in a message.
  const target = HOST_KEYS.map((k) => creds[k]).find((v) => typeof v === 'string' && v.length > 0);
  if (!target) {
    const err = new Error(`no credentials/host for ${plane} — pass a complete set in the request body or save credentials first`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  if (/^https?:\/\//i.test(target)) {
    try {
      const res = await fetchWithTimeout(target, { method: 'GET' }, 5000);
      return { ok: true, message: `host reachable — HTTP ${res.status} from ${target}; credentials not yet validated` };
    } catch (err) {
      console.error(`${plane} connection test: GET ${target} failed: ${(err as Error).message}`);
      return { ok: false, message: `cannot reach ${target}` };
    }
  }

  // Anything that isn't a bare host[:port] (other schemes, embedded paths) is
  // not a test target — reject it instead of parsing a host out of it.
  const m = target.match(/^([a-z0-9._-]+)(?::(\d+))?$/i);
  if (!m) {
    const err = new Error(`cannot parse a host out of '${target}' — pass a bare host[:port] or an http(s) URL`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const host = m[1];
  const port = m[2] ? Number(m[2]) : 443;
  try {
    await tcpCheck(host, port, 5000);
    return { ok: true, message: `TCP connect to ${host}:${port} succeeded — host reachable; credentials not yet validated` };
  } catch (err) {
    console.error(`${plane} connection test: TCP connect to ${host}:${port} failed: ${(err as Error).message}`);
    return { ok: false, message: `TCP connect to ${host}:${port} failed` };
  }
}

systemsRouter.post(
  '/systems/:plane/test',
  h(async (req, res) => {
    const plane = asPlaneId(req.params.plane);
    if (!plane) {
      res.status(404).json({ error: `unknown plane '${req.params.plane}'` });
      return;
    }
    // Test-then-save: a complete credential set in the body wins (the connect
    // flow tests before saving); otherwise fall back to the stored set.
    const raw = req.body as Record<string, unknown> | undefined;
    const bodyCreds = sanitizeCreds(
      raw && typeof raw === 'object' && raw.credentials !== undefined ? raw.credentials : raw,
    );
    const stored = settings.get().planes[plane];
    if (bodyCreds && !completeCredsFor(plane, bodyCreds)) {
      res.status(400).json({ error: `the submitted credentials for ${plane} are incomplete` });
      return;
    }
    const useBody = bodyCreds !== null;
    const creds = useBody ? bodyCreds : stored && Object.keys(stored).length > 0 ? stored : null;
    if (!creds) {
      res
        .status(400)
        .json({ error: `no credentials for ${plane} — pass a complete set in the request body or save credentials first` });
      return;
    }

    const started = Date.now();
    const outcome =
      plane === 'central' ? await testCentral(creds) : plane === 'uxi' ? await testUxi(creds) : await testReachable(plane, creds);
    const ms = Date.now() - started;

    registry.recordCall(plane, {
      path:
        plane === 'central'
          ? 'OAuth client-credentials (connection test)'
          : plane === 'uxi'
            ? 'POST sso token.oauth2 (connection test)'
            : 'reachability check (connection test)',
      ms,
      code: outcome.ok ? 'ok' : 'fail',
    });

    const result: TestResult = { ok: outcome.ok, plane, message: outcome.message, ms, source: useBody ? 'request' : 'stored' };
    res.status(outcome.ok ? 200 : 502).json(result);
  }),
);

// -- Credentials ---------------------------------------------------------------

systemsRouter.post('/systems/:plane/credentials', (req, res) => {
  const plane = asPlaneId(req.params.plane);
  if (!plane) {
    res.status(404).json({ error: `unknown plane '${req.params.plane}'` });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const creds = sanitizeCreds(body && typeof body === 'object' && body.credentials !== undefined
    ? body.credentials
    : body);
  if (!creds) {
    res.status(400).json({ error: 'body must be an object with at least one non-empty credential field' });
    return;
  }

  settings.update({ planes: { [plane]: creds } });
  poller.clearPlane(plane);
  const state = registry.reinitPlane(plane);
  res.json({ plane, state, credentials: settings.maskedView().planes[plane] });
});

systemsRouter.delete('/systems/:plane', (req, res) => {
  const plane = asPlaneId(req.params.plane);
  if (!plane) {
    res.status(404).json({ error: `unknown plane '${req.params.plane}'` });
    return;
  }
  settings.update({ planes: { [plane]: null } });
  poller.clearPlane(plane);
  const state = registry.reinitPlane(plane);
  res.json({ plane, state });
});
