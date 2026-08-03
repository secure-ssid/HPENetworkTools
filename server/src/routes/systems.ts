/**
 * server/src/routes/systems.ts — live plane state, connection tests, credentials.
 *
 *   GET    /api/systems/state              registry truth + poller sync history
 *   POST   /api/systems/sync               immediately poll every linked plane
 *   POST   /api/systems/:plane/test        real connection test (see below)
 *   POST   /api/systems/:plane/credentials save creds, re-init the adapter
 *   DELETE /api/systems/:plane             clear creds, adapter becomes unlinked
 *
 * Connection tests are honest: every independently configurable product uses
 * its adapter's real authentication path followed by one bounded read from a
 * core API dataset. AOS-10 is Central-derived and therefore has no independent
 * credentials or probe. Every attempt is recorded without credential values.
 *
 * Test-then-save: when the request body carries a complete credential set for
 * the plane, THOSE are tested (the connect flow tests before saving); only
 * otherwise do we fall back to the stored credentials. 400 when neither
 * exists. The result's `source` field says which set was exercised.
 */

import { Router } from 'express';
import {
  connectorCatalogEntry,
  migrateLegacyPlaneRecord,
  parseConnectorConfig,
  type ConnectorConfig,
  type ConnectorId,
} from '@hpe/shared';
import { h } from './handler';
import { settings } from '../config/settings';
import { CentralAdapter, GREENLAKE_CCS_TOKEN_URL, isNewCentralGateway } from '../planes/central';
import {
  normalizeSseBaseUrl,
  SSE_KIND_SPEC,
  SseAdapter,
  SseEndpointValidationError,
} from '../planes/sse';
import { UxiAdapter } from '../planes/uxi';
import { httpsBase } from '../planes/transport';
import { GreenLakeAdapter } from '../planes/greenlake';
import { MistAdapter } from '../planes/mist';
import { ClearPassAdapter, httpsFetch as clearpassHttpsFetch } from '../planes/clearpass';
import { Aos8Adapter } from '../planes/aos8';
import { registry } from '../planes/registry';
import { poller, type TickResult } from '../services/poller';
import { SseObjectsError, sseObjects, sseObjectsErrorBody } from '../services/sseObjects';
import { CentralWebhooksError, centralWebhooks } from '../services/centralWebhooks';
import { PLANE_IDS, type PlaneId } from '../planes/types';
import type { ConnectionProbeResult } from '../planes/types';
import { adapterCredentialsFor, connectorConfigFor } from '../connectors/catalog';
import { probeConnector } from '../planes/connectionProbe';

export const systemsRouter = Router();

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
    // `started` is every plane a pull was actually attempted for. It has always
    // included the failures — they were started too — so it cannot double as
    // the success count, and `synced` now travels beside it rather than being
    // inferred. `skippedReason` says WHY each skip happened: a plane on the
    // stub adapter is skipped on every cycle forever, and the summary used to
    // call that "already syncing".
    const started = [...result.synced, ...result.failed];
    res.json({
      ok: result.failed.length === 0,
      requested: result.requested,
      started,
      synced: result.synced,
      ...(result.failed.length > 0 ? { failed: result.failed } : {}),
      ...(result.skipped.length > 0
        ? { skipped: result.skipped, skippedReason: result.skippedReason }
        : {}),
    });
  }),
);

// -- Connection test -----------------------------------------------------------

interface TestResult extends ConnectionProbeResult {
  plane: PlaneId;
  ms: number;
  source: 'request' | 'stored';
}

type LegacyTestOutcome = { ok: boolean; message: string };
const HOST_KEYS = ['host', 'baseUrl', 'publisher'];

/**
 * Keep credential strings plus the scope UI's canonical token array.
 * `scopes: []` deliberately becomes an empty stored string: unlike omission,
 * that is an explicit revocation marker which replaces a previously stored
 * scope set when the SSE record is merged.
 */
function sanitizeCreds(input: unknown): Record<string, string> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === 'scopes' && Array.isArray(v) && v.every((scope) => typeof scope === 'string')) {
      out.scopes = v.map((scope) => scope.trim()).filter(Boolean).join(',');
      continue;
    }
    if (k === 'scopes' && typeof v === 'string') {
      out.scopes = v.trim();
      continue;
    }
    if (typeof v === 'string' && v.trim().length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
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

/** HPE Aruba Networking Central: real OAuth client-credentials token fetch.
 *  New-Central gateways ({region}.api.central…) are minted by GreenLake SSO;
 *  classic *-apigw* gateways mint their own /oauth2/token — host shape picks
 *  the order, a 404 crosses over once (same rule as the adapter). */
async function testCentral(creds: Record<string, string>): Promise<LegacyTestOutcome> {
  const base = creds.gatewayBaseUrl?.replace(/\/+$/, '');
  if (!base || !creds.clientId || !creds.clientSecret) {
    return { ok: false, message: 'central requires gatewayBaseUrl, clientId and clientSecret' };
  }
  // Test-connection posts the client secret to mint a token, so it refuses a
  // plaintext base URL for the same reason the adapter does — and answers with
  // the reason rather than a transport error the operator has to decode.
  let baseUrl: string;
  try {
    baseUrl = httpsBase(base, 'the client secret is posted to mint a token');
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'invalid gatewayBaseUrl' };
  }
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
async function testUxi(creds: Record<string, string>): Promise<LegacyTestOutcome> {
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

/**
 * GreenLake: validate the credentials, not a host.
 *
 * GreenLake is SaaS behind a fixed base URL (the adapter defaults to
 * https://global.api.greenlake.hpe.com), so the operator has no host to type
 * and a reachability probe would only prove HPE's edge is up. Its identity is
 * workspaceId + an SSO client-credentials pair, so the honest test is the same
 * token exchange the adapter itself performs — mirroring testUxi.
 */
async function testGreenLake(creds: Record<string, string>): Promise<LegacyTestOutcome> {
  if (!GreenLakeAdapter.isComplete(creds)) {
    return { ok: false, message: 'greenlake requires workspaceId, clientId and clientSecret' };
  }
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  let tokenRes: globalThis.Response;
  try {
    tokenRes = await fetchWithTimeout(
      GREENLAKE_CCS_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      },
      5000,
    );
  } catch (err) {
    // Never echo the secret or the socket detail back to the client.
    console.error(`greenlake connection test: POST token endpoint failed: ${(err as Error).message}`);
    return { ok: false, message: 'cannot reach HPE SSO to exchange the client credentials' };
  }
  if (!tokenRes.ok) {
    return { ok: false, message: `HPE SSO rejected the client credentials — HTTP ${tokenRes.status}` };
  }
  return {
    ok: true,
    message: `authenticated — token received for workspace ${creds.workspaceId}`,
  };
}

/**
 * HPE Aruba Networking SSE: the token is static (no mint step), so the honest
 * test is the exact call SseAdapter.pull() itself makes for one kind — a
 * minimal paginated GET against Connectors with `Authorization: Bearer`.
 * Path and query spelling are verified against the official pyhpesse SDK
 * source (see server/src/planes/sse.ts's header comment for the citation),
 * not the lower-case '/api/v1/connectors?pageSize=…' shape an earlier
 * assumption used before that source was read.
 */
async function testSse(creds: Record<string, string>): Promise<LegacyTestOutcome> {
  if (!SseAdapter.isComplete(creds)) {
    return { ok: false, message: 'sse requires an Admin API token' };
  }
  const base = normalizeSseBaseUrl(creds.baseUrl);
  const path = `${SSE_KIND_SPEC.connectors.path}?pagenumber=1&pagesize=1`;
  let res: globalThis.Response;
  try {
    res = await fetchWithTimeout(
      `${base}${path}`,
      { headers: { authorization: `Bearer ${creds.token}`, accept: 'application/json' } },
      8000,
    );
  } catch (err) {
    console.error(`sse connection test: GET ${path} failed: ${(err as Error).message}`);
    return { ok: false, message: `cannot reach ${base} to query Connectors` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: `Admin API rejected the token — HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, message: `Admin API answered HTTP ${res.status} querying Connectors` };
  }
  // A 200 alone proves nothing — an HTML error page, a truncated/garbled body,
  // or valid-but-unrecognized JSON must all fail this test honestly rather
  // than being reported as "authenticated". Only a body matching a supported
  // adapter envelope (bare array, or an object exposing one of the documented
  // row-container keys) counts as a real Connectors read.
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    console.error(`sse connection test: GET ${path} returned an unreadable body: ${(err as Error).message}`);
    return { ok: false, message: `Admin API answered HTTP ${res.status} with an unreadable (non-JSON) body querying Connectors` };
  }
  const envelope = parseSseCollectionEnvelope(body);
  if (!envelope) {
    return { ok: false, message: `Admin API answered HTTP ${res.status} with an unrecognized response body querying Connectors` };
  }
  const count = envelope.total !== null ? String(envelope.total) : `${envelope.rows.length}+`;
  return { ok: true, message: `authenticated — token accepted; Connectors query ok, reported connectors: ${count}` };
}

/**
 * One recognized SSE Admin API collection body: either a bare array, or an
 * object exposing one of the documented row-container keys ('data' first —
 * the SDK's own shape — then the tolerated alternates, then a HAL
 * `_embedded` collection). This mirrors planes/sse.ts's own (unexported)
 * extractRows precedence so the connection test accepts exactly what the
 * adapter itself would read — duplicated narrowly here, rather than editing
 * that adapter file, because the helper isn't exported.
 *
 * Anything else — an empty object, a differently-shaped JSON body, an HTML
 * page — is NOT a recognized envelope: this returns null (not `{ rows: [] }`),
 * so a 200 with an unreadable/unrecognized body can never masquerade as a
 * successful, empty Connectors read.
 *
 * An optional total (`totalRecords`/`total`/`count`/`totalCount`) is only
 * trusted when it is a sensible (finite, non-negative) number; otherwise the
 * caller falls back to reporting the page's own row count.
 */
function parseSseCollectionEnvelope(body: unknown): { rows: unknown[]; total: number | null } | null {
  let rows: unknown[] | null = null;
  if (Array.isArray(body)) {
    rows = body;
  } else if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    for (const key of ['data', 'items', 'results', 'records', 'list']) {
      if (Array.isArray(r[key])) {
        rows = r[key] as unknown[];
        break;
      }
    }
    if (!rows && r._embedded && typeof r._embedded === 'object') {
      for (const value of Object.values(r._embedded as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          rows = value;
          break;
        }
      }
    }
  }
  if (!rows) return null;
  const r = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const totalRaw = r.totalRecords ?? r.total ?? r.count ?? r.totalCount;
  const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw) && totalRaw >= 0 ? totalRaw : null;
  return { rows, total };
}

/**
 * The exact SSE credential record a request will test or persist: whatever
 * is already stored, overlaid by any submitted fields, with baseUrl run
 * through the one canonicalizer. This is what makes a token-only re-key
 * request test and save the SAME record — the stored custom HTTPS base URL
 * survives the overlay instead of the test silently falling back to the
 * default while the save keeps the custom URL underneath it.
 */
function buildSseCredentialRecord(
  stored: Record<string, string> | null | undefined,
  submitted: Record<string, string> | null,
): Record<string, string> {
  const merged: Record<string, string> = { ...(stored ?? {}), ...(submitted ?? {}) };
  merged.baseUrl = normalizeSseBaseUrl(merged.baseUrl);
  return merged;
}

/** Generic planes: reachability only, reported honestly. */
/**
 * ClearPass validates the CREDENTIALS, not just reachability: client
 * credentials mint a real token (POST /api/oauth), a pre-minted token reads
 * the endpoint repository — and CPPM's own refusal detail is the message.
 * A lab CPPM's self-signed cert is handled by the adapter's node:https
 * transport (verifyTls opt-in); plain-http targets (mock servers) use fetch.
 * Secrets are dialed, never echoed: messages carry status + CPPM detail only.
 */
async function testClearPass(creds: Record<string, string>): Promise<LegacyTestOutcome> {
  const target = HOST_KEYS.map((k) => creds[k]).find((v) => typeof v === 'string' && v.length > 0);
  if (!target) {
    const err = new Error('no credentials/host for clearpass — pass a complete set in the request body or save credentials first') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const base = (/^https?:\/\//i.test(target) ? target : `https://${target}`).replace(/\/+$/, '');
  const transport = base.startsWith('https:') ? clearpassHttpsFetch(creds.verifyTls === 'true') : fetch;
  const call = async (path: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      return await transport(`${base}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const hasOauth = ClearPassAdapter.hasOauthCreds(creds);
  try {
    if (hasOauth) {
      const res = await call('/api/oauth', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 200 && typeof body?.access_token === 'string' && body.access_token.length > 0) {
        const hours = typeof body.expires_in === 'number' ? ` · token lifetime ${Math.round(body.expires_in / 3600)}h` : '';
        return { ok: true, message: `authenticated — client credentials accepted, token minted${hours}` };
      }
      const detail =
        typeof body?.detail === 'string' ? body.detail : typeof body?.title === 'string' ? body.title : null;
      return { ok: false, message: `CPPM refused the client — HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
    }
    if (typeof creds.token === 'string' && creds.token.trim().length > 0) {
      const res = await call('/api/endpoint?limit=1', {
        method: 'GET',
        headers: { authorization: `Bearer ${creds.token}`, accept: 'application/json' },
      });
      if (res.status === 200) return { ok: true, message: 'authenticated — token accepted; endpoint repository readable' };
      if (res.status === 401) return { ok: false, message: 'CPPM rejected the token — HTTP 401 (expired or revoked)' };
      if (res.status === 403) {
        return { ok: false, message: 'token accepted but lacks Endpoint repository privileges (HTTP 403) — check the API client privileges in CPPM' };
      }
      return { ok: false, message: `CPPM answered HTTP ${res.status} reading the endpoint repository` };
    }
    return { ok: false, message: 'clearpass requires clientId + clientSecret, or a pre-minted API token' };
  } catch (err) {
    const e = err as Error;
    console.error(`clearpass connection test: ${e.message}`);
    return { ok: false, message: `cannot reach ${base} — ${e.name === 'AbortError' ? 'timed out after 8s' : 'connection failed'}` };
  }
}

function connectorFromLegacy(
  plane: PlaneId,
  submitted: Record<string, string> | null,
): { config: ConnectorConfig | null; source: 'request' | 'stored' } {
  if (plane === 'aos10') {
    const err = new Error('AOS-10 is discovered through Central and has no independent connector probe') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const id = plane as ConnectorId;
  const stored = connectorConfigFor(settings.get(), id);
  if (!submitted) return { config: stored, source: 'stored' };
  // A submitted record must stand on its own. Reusing stored secrets while
  // testing a partial draft can validate a different identity than the user
  // entered. SSE is the one intentional overlay: token rotation preserves its
  // separately configured custom Admin API base URL and scope declaration.
  let legacy = { ...submitted };
  if (id === 'sse') legacy = buildSseCredentialRecord(stored ? adapterCredentialsFor(stored) : null, submitted);
  if (legacy.scopes !== undefined) {
    const allowed = new Set(connectorCatalogEntry(id).scopeOptions.map((scope) => scope.value));
    const normalized = new Set<string>();
    for (const scope of legacy.scopes.split(',').map((value) => value.trim()).filter(Boolean)) {
      if (allowed.has(scope)) normalized.add(scope);
      else if (scope.includes('write') && allowed.has('write:direct')) normalized.add('write:direct');
      else if (scope.startsWith('read') && allowed.has('read:inventory')) normalized.add('read:inventory');
    }
    legacy.scopes = [...normalized].join(',');
  }
  try {
    const config = migrateLegacyPlaneRecord(id, legacy);
    if (!config) throw new Error('incomplete');
    return { config: { ...config, enabled: true } as ConnectorConfig, source: 'request' };
  } catch {
    const err = new Error(`the submitted connector configuration for ${id} is incomplete or unsafe`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
}

/**
 * Typed editor payloads carry nested `auth`; legacy drawers submit only flat
 * strings. Parse the typed shape before the legacy sanitizer can discard its
 * booleans, numbers, arrays, and nested credentials. Parser errors stay
 * generic here so neither credentials nor vendor-specific internals ride back.
 */
function typedConnectorFromRequest(plane: PlaneId, input: unknown): ConnectorConfig | undefined {
  if (plane === 'aos10' || input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(input, 'auth')) return undefined;
  const id = plane as ConnectorId;
  try {
    return parseConnectorConfig(id, input) as ConnectorConfig;
  } catch {
    const err = new Error(`the submitted connector configuration for ${id} is incomplete or unsafe`) as Error & { status?: number };
    err.status = 400;
    throw err;
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
    const submitted = raw && typeof raw === 'object' && raw.credentials !== undefined ? raw.credentials : raw;
    const typed = typedConnectorFromRequest(plane, submitted);
    const bodyCreds = typed ? null : sanitizeCreds(submitted);
    const resolved = typed
      ? { config: typed, source: 'request' as const }
      : connectorFromLegacy(plane, bodyCreds);
    if (!resolved.config) {
      res
        .status(400)
        .json({ error: `no credentials for ${plane} — pass a complete set in the request body or save credentials first` });
      return;
    }

    const started = Date.now();
    const outcome = await probeConnector(resolved.config, (call) => registry.recordCall(plane, call));
    const ms = Date.now() - started;

    const result: TestResult = { ...outcome, plane, ms, source: resolved.source };
    res.status(outcome.ok ? 200 : 502).json(result);
  }),
);

// -- Credentials ---------------------------------------------------------------

/** How long a credential save waits for the first poll before answering.
 *  Overridable for a slow WAN, or downward for tests that seed the poller
 *  by hand and do not want to wait on a real pull. */
const CREDENTIAL_INDEX_WAIT_MS = Number(process.env.HPE_CREDENTIAL_INDEX_WAIT_MS ?? 9_000);

/** The outcome of the poll a credential save triggers — the poller's own three
 *  results, plus the one this route can produce on its own. */
export type FirstPollOutcome = TickResult | 'pending';

/**
 * Poll one plane with its new credentials and report what happened, waiting no
 * longer than CREDENTIAL_INDEX_WAIT_MS for the answer.
 *
 * Storing the credentials used to be the whole of the save: the cache was
 * cleared, the adapter re-initialised, and nothing asked the plane anything.
 * The portal answered "Saved and indexing" over a description reading
 * "re-indexes on the next poll" — the two contradicted each other, and in demo
 * mode with no live section there is no next poll to re-index on at all. The
 * plane sat empty, and working credentials looked exactly like broken ones.
 *
 * The wait is bounded because the poll is not: a plane whose host does not
 * route takes the full per-plane poll timeout to fail, and an operator who has
 * just pasted the wrong address should not hold a request open for two minutes
 * to be told so. Past the budget this returns 'pending' and the poll carries on
 * in the background — 'pending' is a real answer, distinct from all three of
 * the poller's, and the caller has to be able to say it did not wait for the
 * result rather than imply one. Nothing is cancelled, so the plane still
 * indexes; and a pull that outlives a later re-init is discarded by the
 * poller's own generation guard rather than landing stale.
 */
async function firstPollOutcome(plane: PlaneId): Promise<FirstPollOutcome> {
  const poll = poller.syncNowFor(plane);
  if (CREDENTIAL_INDEX_WAIT_MS <= 0) {
    void poll.catch(() => {}); // still runs; we simply do not wait to hear
    return 'pending';
  }
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), CREDENTIAL_INDEX_WAIT_MS);
    timer.unref?.(); // never hold the process open for a wait nobody is reading
  });
  try {
    return await Promise.race([poll, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

systemsRouter.post(
  '/systems/:plane/credentials',
  h(async (req, res) => {
    const plane = asPlaneId(req.params.plane);
    if (!plane) {
      res.status(404).json({ error: `unknown plane '${req.params.plane}'` });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const rawSubmitted = body && typeof body === 'object' && body.credentials !== undefined
      ? body.credentials
      : body;
    const typed = typedConnectorFromRequest(plane, rawSubmitted);
    const submitted = typed ? null : sanitizeCreds(rawSubmitted);
    if (!typed && !submitted) {
      res.status(400).json({ error: 'body must be an object with at least one non-empty credential field' });
      return;
    }

    const resolved = typed
      ? { config: typed, source: 'request' as const }
      : connectorFromLegacy(plane, submitted);
    if (!resolved.config) {
      res.status(400).json({ error: `the submitted connector configuration for ${plane} is incomplete` });
      return;
    }
    if (plane === 'central') {
      try {
        centralWebhooks.assertCentralCredentialsMutable();
      } catch (err) {
        if (err instanceof CentralWebhooksError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }
    if (plane === 'sse') {
      try {
        sseObjects.assertCredentialsMutable();
      } catch (err) {
        if (err instanceof SseObjectsError) {
          if (err.status >= 500) console.error(`error: ${err.message}`);
          res.status(err.status).json(sseObjectsErrorBody(err));
          return;
        }
        throw err;
      }
    }
    const started = Date.now();
    const probe = await probeConnector(resolved.config, (call) => registry.recordCall(plane, call));
    registry.recordCall(plane, {
      path: `authenticated ${probe.dataset} probe (credential save)`,
      ms: Date.now() - started,
      code: probe.ok ? 'ok' : 'fail',
    });
    if (!probe.ok) {
      res.status(502).json({ ...probe, plane });
      return;
    }

    settings.update({ connectors: { [plane]: resolved.config } });
    poller.clearPlane(plane);
    registry.reinitPlane(plane);
    const indexed = await firstPollOutcome(plane);
    res.json({
      plane,
      // Read AFTER the poll: reinitPlane's state predates the attempt, so
      // returning that one describes the moment before the credentials were
      // ever tried and leaves the caller to assume the rest.
      state: registry.get(plane).state(),
      indexed,
      credentials: settings.maskedView().planes[plane],
      connector: plane === 'aos10' ? null : settings.maskedView().connectors[plane as ConnectorId],
    });
  }),
);

systemsRouter.delete('/systems/:plane', (req, res) => {
  const plane = asPlaneId(req.params.plane);
  if (!plane) {
    res.status(404).json({ error: `unknown plane '${req.params.plane}'` });
    return;
  }
  if (plane === 'sse') {
    try {
      sseObjects.assertCredentialsMutable();
    } catch (err) {
      if (err instanceof SseObjectsError) {
        if (err.status >= 500) console.error(`error: ${err.message}`);
        res.status(err.status).json(sseObjectsErrorBody(err));
        return;
      }
      throw err;
    }
  }
  if (plane === 'central') {
    try {
      centralWebhooks.assertCentralCredentialsMutable();
    } catch (err) {
      if (err instanceof CentralWebhooksError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }
  settings.update({ planes: { [plane]: null } });
  poller.clearPlane(plane);
  const state = registry.reinitPlane(plane);
  res.json({ plane, state });
});
