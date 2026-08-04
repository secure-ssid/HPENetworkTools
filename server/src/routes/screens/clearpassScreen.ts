/**
 * ClearPass screen routes: envelope, endpoint page, service detail, CSV export.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Static paths (`/clearpass/export`, `/clearpass/endpoints`) register before
 * `/clearpass/services/:id` so Express never treats those segments as ids.
 *
 * Honesty: policy inventories ride the envelope only when the plane reported
 * them; endpoint rows stay on the on-demand page (not the screen snapshot);
 * export columns are operator-visible facts only — no secrets/passwords/tokens.
 */

import type { Request, Response, Router } from 'express';
import {
  AUTH_EVENTS,
  CLEARPASS_AUTH_SOURCES,
  CLEARPASS_ENDPOINTS,
  CLEARPASS_ENFORCEMENT_POLICIES,
  CLEARPASS_ENFORCEMENT_PROFILES,
  CLEARPASS_EXPORT_PARTS,
  CLEARPASS_LOCAL_USERS,
  CLEARPASS_NETWORK_DEVICES,
  CLEARPASS_ROLES,
  CLEARPASS_SERVICES,
  CLEARPASS_SERVICE_DETAILS,
  type ClearPassExportPart,
  type ClearPassServiceDetailLive,
  type ClearPassServiceRow,
  type EndpointRow,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryFlag, queryString } from '../../lib/query';
import { poller } from '../../services/poller';
import { registry } from '../../planes/registry';
import { evaluateWriteAdmission } from '../../services/writeAdmission';
import {
  blending,
  dataSource,
  envelope,
} from './context';
import {
  DETAIL_TTL_MS,
  attemptDetail,
  cachedDetail,
  detailBudgetNote,
  neverThrows,
  settle,
} from './detailCache';
import { LiveAuthEvent, planesMissingDataset } from './liveCore';
import { withOwningPlane } from './authEventsScreen';
import { applyListFilters } from './listQuery';

/** ClearPass's deliberately small, explicitly requested endpoint page. */
const CLEARPASS_ENDPOINT_PAGE_DEFAULT_LIMIT = 50;
const CLEARPASS_ENDPOINT_PAGE_MAX_LIMIT = 100;

const ENDPOINT_LIST_FIELDS = [
  'hostname',
  'mac',
  'ip',
  'status',
  'category',
  'family',
  'os',
  'profile',
  'description',
] as const;

const SESSION_LIST_FIELDS = [
  'who',
  'mac',
  'result',
  'service',
  'method',
  'reason',
  'role',
  'nas',
  'plane',
] as const;

/**
 * ClearPass endpoint repository + auth feed + policy inventories, one screen.
 * Demo mode serves the fixtures; live mode reads the poller cache —
 * `endpoints` is the best-effort dataset (ClearPassAdapter.pull() never fails
 * the auth feed on an endpoint-read failure), so a plane that pulled auth
 * events but not endpoints this cycle still contributes its rows here instead
 * of vanishing the whole screen.
 *
 * The policy inventories (NADs, auth sources, roles, enforcement
 * policies/profiles, local users, services, device groups) are ClearPass-only
 * datasets — nothing merges them across planes, so they come straight from
 * the clearpass contribution, the same pattern as liveMistSle(). Each rides
 * the envelope ONLY when the plane's pull carried it: an absent key means
 * this CPPM did not report that collection (a failed read, or a build that
 * does not expose it), and the screen says so instead of rendering an
 * authoritative-looking empty table. The demo estate's CPPM is a 6.11 build,
 * so services ARE served here (CLEARPASS_SERVICES); /api/device-group stays
 * the collection this CPPM does not expose, absent in demo mode too — the
 * screen renders the same honest line in both modes.
 */
export function clearpassBody(): Record<string, unknown> {
  if (dataSource() === 'demo') {
    return {
      dataSource: 'demo',
      canWrite: true,
      syncedAt: new Date().toISOString(),
      missingSources: [],
      endpointTotal: CLEARPASS_ENDPOINTS.length,
      // Endpoint rows belong to GET /api/clearpass/endpoints. Keeping this
      // screen envelope empty prevents its initial mount from carrying the
      // whole fixture repository alongside the on-demand page.
      endpoints: [],
      authEvents: AUTH_EVENTS,
      networkDevices: CLEARPASS_NETWORK_DEVICES,
      authSources: CLEARPASS_AUTH_SOURCES,
      roles: CLEARPASS_ROLES,
      enforcementPolicies: CLEARPASS_ENFORCEMENT_POLICIES,
      enforcementProfiles: CLEARPASS_ENFORCEMENT_PROFILES,
      localUsers: CLEARPASS_LOCAL_USERS,
      services: CLEARPASS_SERVICES,
    };
  }
  const authEvents = withOwningPlane(poller.getCache().authEvents as LiveAuthEvent[]);
  // A plane can be linked and contributing auth events without ever answering
  // the endpoint read (or vice versa) — union both gaps so the banner names
  // every plane missing either half of this screen, not just one.
  const missing = [...planesMissingDataset('endpoints'), ...planesMissingDataset('authEvents')].filter(
    (p, i, all) => all.indexOf(p) === i,
  );
  const cp = poller.contributionsByPlane().get('clearpass');
  return {
    dataSource: 'live',
    canWrite: evaluateWriteAdmission({ operation: 'clearpass-object', plane: 'clearpass' }).ok,
    syncedAt: poller.lastSyncFor('endpoints', 'authEvents'),
    missingSources: missing,
    endpointTotal: registry.state('clearpass').deviceCount,
    // The poller cache is a capped snapshot for joins and screen freshness,
    // not a pageable repository. Do not mount it into this endpoint table.
    endpoints: [],
    authEvents,
    ...(cp?.networkDevices !== undefined ? { networkDevices: cp.networkDevices } : {}),
    ...(cp?.authSources !== undefined ? { authSources: cp.authSources } : {}),
    ...(cp?.roles !== undefined ? { roles: cp.roles } : {}),
    ...(cp?.enforcementPolicies !== undefined ? { enforcementPolicies: cp.enforcementPolicies } : {}),
    ...(cp?.enforcementProfiles !== undefined ? { enforcementProfiles: cp.enforcementProfiles } : {}),
    ...(cp?.localUsers !== undefined ? { localUsers: cp.localUsers } : {}),
    ...(cp?.services !== undefined ? { services: cp.services } : {}),
    ...(cp?.deviceGroups !== undefined ? { deviceGroups: cp.deviceGroups } : {}),
  };
}

/**
 * Endpoint rows for CSV export: demo fixtures, or the poller's capped live
 * snapshot (same facts the rest of the portal joins on — not a full walk).
 */
function exportEndpoints(): EndpointRow[] {
  if (dataSource() === 'demo') return CLEARPASS_ENDPOINTS;
  return poller.getCache().endpoints ?? [];
}

function exportSessions(): LiveAuthEvent[] {
  if (dataSource() === 'demo') return AUTH_EVENTS as LiveAuthEvent[];
  return withOwningPlane(poller.getCache().authEvents as LiveAuthEvent[]);
}

/** Service collection rows for CSV — demo fixtures or the ClearPass pull contribution. */
function exportServices(): ClearPassServiceRow[] {
  if (dataSource() === 'demo') return CLEARPASS_SERVICES;
  const cp = poller.contributionsByPlane().get('clearpass');
  return (cp?.services as ClearPassServiceRow[] | undefined) ?? [];
}

const SERVICE_LIST_FIELDS = [
  'id',
  'name',
  'type',
  'description',
  'template',
  'rulesSummary',
] as const;

/**
 * Services tab filters: `q` substring over identity/type/template/rules;
 * `enabled` via shared queryFlag vocabulary (1/true/yes/on | 0/false/no/off).
 * Unknown/empty values are no-ops.
 */
export function filterClearPassServiceRows<
  T extends {
    id?: string | null;
    name?: string | null;
    type?: string | null;
    description?: string | null;
    template?: string | null;
    enabled?: boolean | null;
    rulesSummary?: string | null;
    authSources?: string[] | null;
  },
>(list: T[], filters: { q?: string; enabled?: string }): T[] {
  const q = (filters.q ?? '').trim().toLowerCase();
  /* Same tokens as queryFlag — keep filterClearPassServiceRows callable with a
     plain string so unit tests and the export route stay lightweight. */
  const enabledWant = queryFlag({ query: { enabled: filters.enabled ?? '' } }, 'enabled');
  if (!q && enabledWant === null) return list;
  return list.filter((row) => {
    if (enabledWant !== null) {
      if (row.enabled !== true && row.enabled !== false) return false;
      if (row.enabled !== enabledWant) return false;
    }
    if (q) {
      const hay = [
        row.id,
        row.name,
        row.type,
        row.description,
        row.template,
        row.rulesSummary,
        ...(row.authSources ?? []),
      ]
        .map((v) => String(v ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Parsed endpoint list filters from `?q=&status=&category=`. Empty = no-op. */
export function clearPassEndpointFilterQuery(req: {
  query: Request['query'];
}): { q: string; status: string; category: string } {
  return {
    q: queryString(req, 'q').toLowerCase(),
    status: queryString(req, 'status'),
    category: queryString(req, 'category'),
  };
}

/**
 * Endpoint row filter shared by CSV export and the on-demand page route.
 * Status/category are exact (case-sensitive) like the ClearPass Selects;
 * `q` is a case-insensitive substring over hostname/MAC/IP (+ other list fields
 * on export via applyListFilters). Unknown / empty values are no-ops.
 */
export function filterClearPassEndpointRows(
  list: EndpointRow[],
  filters: { q?: string; status?: string; category?: string },
): EndpointRow[] {
  const q = (filters.q ?? '').trim().toLowerCase();
  const status = (filters.status ?? '').trim();
  const category = (filters.category ?? '').trim();
  if (!q && !status && !category) return list;
  return list.filter((row) => {
    if (status && String(row.status ?? '') !== status) return false;
    if (category && String(row.category ?? '') !== category) return false;
    if (q) {
      const hay = [row.hostname, row.mac, row.ip, row.category, row.family, row.os, row.profile, row.description]
        .map((v) => String(v ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Exact status / category filters for endpoint CSV export — same semantics as
 * the ClearPass screen Selects (case-sensitive match on the row words).
 * Unknown / empty values are no-ops (never invent an empty export).
 */
export function applyClearPassEndpointExactFilters(
  req: Request,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const list = body.endpoints;
  if (!Array.isArray(list)) return body;
  const { status, category } = clearPassEndpointFilterQuery(req);
  if (!status && !category) return body;
  return { ...body, endpoints: filterClearPassEndpointRows(list as EndpointRow[], { status, category }) };
}

function clearPassPageInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function clearPassEndpointPageEnvelope(
  source: 'demo' | 'live',
  state: 'ok' | 'empty' | 'failed' | 'unavailable',
  endpoints: EndpointRow[],
  offset: number,
  limit: number,
  total: number | null,
  nextOffset: number | null,
  more: 'yes' | 'unknown' | 'no',
) {
  // Keep this route's contract closed: mapped endpoints plus pagination facts,
  // never vendor payloads, headers, transport errors, or configuration text.
  return { dataSource: source, state, endpoints, offset, limit, total, nextOffset, more };
}

async function serveClearPassEndpointPage(
  res: Response,
  offset: number,
  limit: number,
  filters: { q: string; status: string; category: string },
): Promise<void> {
  const hasFilters = Boolean(filters.q || filters.status || filters.category);

  if (dataSource() === 'demo') {
    /* Demo repository is fully in-memory: filter first, then page so Next/Prev
       walk the filtered set (same q/status/category semantics as export). */
    const filtered = filterClearPassEndpointRows(CLEARPASS_ENDPOINTS as EndpointRow[], filters);
    const endpoints = filtered.slice(offset, offset + limit);
    const total = filtered.length;
    const more = offset + endpoints.length < total ? 'yes' : 'no';
    res.json(
      clearPassEndpointPageEnvelope(
        'demo',
        endpoints.length === 0 ? 'empty' : 'ok',
        endpoints,
        offset,
        limit,
        total,
        more === 'yes' ? offset + endpoints.length : null,
        more,
      ),
    );
    return;
  }

  // This read is user-driven rather than poller work, so it honours the same
  // daily protection as other on-demand plane reads. No budget is an explicit
  // unavailable answer; it never turns into the demo repository.
  if (detailBudgetNote('clearpass')) {
    res.json(clearPassEndpointPageEnvelope('live', 'unavailable', [], offset, limit, null, null, 'unknown'));
    return;
  }
  const adapter = registry.get('clearpass');
  const read = adapter.endpointPage;
  if (typeof read !== 'function') {
    res.json(clearPassEndpointPageEnvelope('live', 'unavailable', [], offset, limit, null, null, 'unknown'));
    return;
  }
  try {
    const page = await read.call(adapter, offset, limit);
    /* Live vendor pages are already offset/limit slices. Apply portal filters
       to the returned rows only — never invent a filtered repository total. */
    const endpoints = hasFilters
      ? filterClearPassEndpointRows(page.endpoints as EndpointRow[], filters)
      : page.endpoints;
    const total = hasFilters ? null : page.total;
    const nextOffset = page.nextOffset;
    const more = page.more;
    const state =
      page.kind === 'ok' && endpoints.length === 0
        ? 'empty'
        : page.kind;
    res.json(
      clearPassEndpointPageEnvelope(
        'live',
        state,
        endpoints,
        offset,
        limit,
        total,
        nextOffset,
        more,
      ),
    );
  } catch {
    // An adapter seam or transport failure stays visibly failed, with no raw
    // vendor body or error text crossing this boundary.
    res.json(clearPassEndpointPageEnvelope('live', 'failed', [], offset, limit, null, null, 'unknown'));
  }
}

/** A service detail payload that carries no object and says why — the same
 *  contract as the other detail stubs: sections {} reads 'not-fetched' (we
 *  chose not to ask, e.g. the call budget is spent), 'failed' means we
 *  asked and it broke. */
function serviceDetailStub(id: string, note: string, attempted: boolean): ClearPassServiceDetailLive {
  return {
    service: null,
    source: {
      plane: 'clearpass',
      at: new Date().toISOString(),
      sections: attempted ? { service: 'failed' } : {},
      note,
    },
  };
}

async function serveClearPassServiceDetail(res: Response, id: string): Promise<void> {
  if (dataSource() === 'demo') {
    if (blending() && poller.contributionsByPlane().get('clearpass')?.services !== undefined) {
      await serveLiveClearPassServiceDetail(res, id);
      return;
    }
    const detail = CLEARPASS_SERVICE_DETAILS[id] ?? null;
    if (detail === null) {
      res.status(404).json({ error: `no service detail recorded for '${id}'`, dataSource: 'demo' });
      return;
    }
    res.json(envelope({ serviceDetail: detail }));
    return;
  }
  await serveLiveClearPassServiceDetail(res, id);
}

/** Live/blend half of the route: only the ClearPass adapter can answer (no
 *  other plane holds CPPM policy), so there is no badge walk — an adapter
 *  without the capability is the honest 'not reported'. */
async function serveLiveClearPassServiceDetail(res: Response, id: string): Promise<void> {
  const adapter = registry.get('clearpass');
  const read = adapter.serviceDetail;
  if (typeof read !== 'function' || !id) {
    res.json(envelope({ serviceDetail: null }));
    return;
  }
  const budget = detailBudgetNote('clearpass');
  if (budget) {
    res.json(envelope({ serviceDetail: serviceDetailStub(id, budget, false) }));
    return;
  }
  const detail = await neverThrows(
    cachedDetail(`clearpass:service:${id}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => read.call(adapter, id),
        (note) => serviceDetailStub(id, note, true),
      ),
    ),
  );
  res.json(envelope({ serviceDetail: detail }));
}

function parseExportPart(req: Request): 'all' | ClearPassExportPart | null {
  const raw = req.query.part;
  if (raw === undefined || raw === '') return 'all';
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === 'all') return 'all';
  if (v === 'endpoint') return 'endpoints';
  if (v === 'session' || v === 'auth') return 'sessions';
  if (v === 'service') return 'services';
  if ((CLEARPASS_EXPORT_PARTS as readonly string[]).includes(v)) return v as ClearPassExportPart;
  return null;
}

export function registerClearPassRoutes(router: Router): void {
  /**
   * GET /api/clearpass/export — CSV of endpoint repository snapshot + auth
   * sessions (optional q; optional status/category exact match on endpoints;
   * optional part=endpoints|sessions|services). part=services is a dedicated
   * service-column CSV (optional q + enabled). Omit/all = endpoints+sessions only.
   * No secrets. Must stay ahead of /clearpass/services/:id.
   */
  router.get('/clearpass/export', (req, res) => {
    const part = parseExportPart(req);
    if (part === null) {
      res.status(400).json({
        error: "part must be 'endpoints', 'sessions', 'services', or omitted",
        code: 'CLEARPASS_EXPORT_PART',
      });
      return;
    }

    if (part === 'services') {
      const q = queryString(req, 'q');
      const enabled = queryString(req, 'enabled');
      const listed = applyListFilters(
        req,
        { services: exportServices() },
        'services',
        [...SERVICE_LIST_FIELDS],
      );
      const services = filterClearPassServiceRows(
        (listed.services as ClearPassServiceRow[]) ?? [],
        { q, enabled },
      );
      sendCsv(
        res,
        'clearpass-services.csv',
        [
          'id',
          'name',
          'type',
          'description',
          'template',
          'enabled',
          'hitCount',
          'orderNo',
          'authSources',
          'rulesSummary',
        ],
        services.map((s) => [
          s.id ?? '',
          s.name ?? '',
          s.type ?? '',
          s.description ?? '',
          s.template ?? '',
          s.enabled === true ? 'yes' : s.enabled === false ? 'no' : '',
          s.hitCount == null ? '' : String(s.hitCount),
          s.orderNo == null ? '' : String(s.orderNo),
          (s.authSources ?? []).join('; '),
          s.rulesSummary ?? '',
        ]),
      );
      return;
    }

    const endpointBody = applyListFilters(
      req,
      { endpoints: exportEndpoints() },
      'endpoints',
      [...ENDPOINT_LIST_FIELDS],
    );
    const endpointsExact = applyClearPassEndpointExactFilters(req, endpointBody);
    const sessionBody = applyListFilters(
      req,
      { sessions: exportSessions() },
      'sessions',
      [...SESSION_LIST_FIELDS],
    );
    const endpoints = (part === 'all' || part === 'endpoints'
      ? ((endpointsExact.endpoints as EndpointRow[]) ?? [])
      : []);
    const sessions = (part === 'all' || part === 'sessions'
      ? ((sessionBody.sessions as LiveAuthEvent[]) ?? [])
      : []);

    sendCsv(
      res,
      'clearpass-export.csv',
      [
        'section',
        'hostname',
        'mac',
        'ip',
        'status',
        'category',
        'family',
        'os',
        'profile',
        'description',
        'updatedAt',
        'time',
        'at',
        'who',
        'result',
        'service',
        'method',
        'role',
        'reason',
        'nas',
        'plane',
      ],
      [
        ...endpoints.map((e) => [
          'endpoint',
          e.hostname ?? '',
          e.mac ?? '',
          e.ip ?? '',
          e.status ?? '',
          e.category ?? '',
          e.family ?? '',
          e.os ?? '',
          e.profile ?? '',
          e.description ?? '',
          e.updatedAt ?? '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ]),
        ...sessions.map((s) => [
          'session',
          '',
          s.mac ?? '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          s.time ?? '',
          s.at ?? '',
          s.who ?? '',
          s.result ?? '',
          s.service ?? '',
          s.method ?? '',
          s.role ?? '',
          s.reason ?? '',
          s.nas ?? '',
          s.plane ?? '',
        ]),
      ],
    );
  });

  /**
   * GET /api/clearpass/endpoints?offset=&limit=&q=&status=&category=
   *
   * The main ClearPass envelope remains a small poller snapshot for its stats
   * and other policy tabs. Endpoint rows come from this separate on-demand
   * route so opening the endpoints tab neither walks nor mounts the repository.
   * Optional filters match export: demo filters the full fixture then pages;
   * live filters only the vendor page just returned.
   */
  router.get('/clearpass/endpoints', (req, res) => {
    const offset = clearPassPageInteger(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clearPassPageInteger(
      req.query.limit,
      CLEARPASS_ENDPOINT_PAGE_DEFAULT_LIMIT,
      1,
      CLEARPASS_ENDPOINT_PAGE_MAX_LIMIT,
    );
    if (offset === null || limit === null) {
      res.status(400).json({ error: 'offset must be an integer >= 0 and limit must be an integer from 1 to 100' });
      return;
    }
    settle(res, serveClearPassEndpointPage(res, offset, limit, clearPassEndpointFilterQuery(req)));
  });

  router.get('/clearpass', (_req, res) => {
    res.json(clearpassBody());
  });

  /**
   * GET /api/clearpass/services/:id — ONE service's full definition for the
   * Services-tab drawer.
   *
   * On-demand on purpose: the summary rows ride the screen envelope, but the
   * full object is one more GET per service, so it runs only when an operator
   * opens the drawer — behind the shared TTL cache, single-flight and
   * call-budget gate, exactly like the device/client detail reads. The
   * ClearPass adapter is the only plane that can answer; an adapter without
   * the capability is the honest `serviceDetail: null`, never a fabricated
   * object. The adapter's own verdicts ride in the payload: 'empty' means the
   * box 404'd (no such service), 'failed' means the read broke.
   *
   * Demo mode serves the authored CLEARPASS_SERVICE_DETAILS fixture and 404s
   * an id the demo world did not author — the same honest 'not recorded' the
   * SLE drill route keeps. Blend follows the /central route's rule: with
   * blendLive on AND live services reported, a fixture detail for the live
   * CPPM's world would be fabrication, so the read rides the adapter instead.
   */
  router.get('/clearpass/services/:id', (req, res) => {
    settle(res, serveClearPassServiceDetail(res, req.params.id.trim()));
  });
}
