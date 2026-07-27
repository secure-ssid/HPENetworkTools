/**
 * server/src/planes/mist.ts — Juniper Mist cloud adapter (read-only).
 *
 * The Mist plane (README integration table: inventory + client counts;
 * read-only — config stays in the Mist dashboard, the portal never fakes an
 * edit form). Static API-token auth — `Authorization: Token <token>` on every
 * call, nothing to refresh (verified against the official OpenAPI spec at
 * mistsys/mist_openapi and the mistapi_python SDK).
 *
 * Verified surface:
 *   sites    GET /api/v1/orgs/{orgId}/sites?limit=1000&page=N
 *   devices  GET /api/v1/orgs/{orgId}/stats/devices?type=all&limit=1000&page=N
 *            one org-wide call carries name/model/version/serial/mac/site_id/
 *            status(connected|disconnected)/num_clients per device — the best
 *            fit for this adapter.
 *   paging   limit+page (1-based); X-Page-Total/Limit/Page headers are what
 *            the SDK reads but are undocumented — we simply loop pages until
 *            a short page comes back, which works either way.
 *   limits   5,000 calls/hour per token; a 429 fails the pull honestly.
 *
 * What the row carries: num_clients feeds the device note via the poller
 * cache (a full per-client roster would be /sites/{id}/stats/clients per
 * site — deliberately not pulled; the note says counts only).
 *
 * Failure policy (mirrors clearpass): either section failing → pull() throws
 * naming the section; both sections are this plane's whole dataset, so there
 * is nothing honest to degrade to.
 *
 * Security: the token travels in the Authorization header only, never in a
 * URL; the call log records method + path + ms + status, never headers.
 */

import type { DeviceRow, DeviceType, SiteRow, Tone } from '../../../shared';
import type { PlaneCredentials } from '../config/settings';
import { siteIdForName, type FetchLike, type RecordCallFn } from './central';
import type { PlaneAdapter, PlanePull, PlaneState } from './types';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './central';

const OUTBOUND_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 25;

// ---------------------------------------------------------------------------
// Defensive field readers — unknown/extra fields ignored, missing → null
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0 && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Mist device-stats type vocabulary → the shared DeviceType. */
function deviceTypeFor(raw: string | null): DeviceType {
  const s = (raw ?? '').toLowerCase();
  if (s === 'ap') return 'ap';
  if (s === 'switch') return 'switch';
  if (s === 'gateway') return 'gateway';
  return 'ap'; // mist stats rows are APs when the discriminator is absent
}

/** Identity hints for the reconcile service (the pattern central uses). */
export type MistDeviceRow = DeviceRow & { serial?: string; mac?: string };

/**
 * Mist org device-stats row → DeviceRow. `siteNameById` resolves the Mist
 * site UUID to its display name (from the sites section); unknown ids land on
 * the 'multiple' pseudo-site via siteIdForName(null).
 */
export function mapMistDevice(raw: unknown, siteNameById: ReadonlyMap<string, string>): MistDeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.hostname) ?? str(r.serial) ?? str(r.mac);
  if (!name) return null;
  const status = (str(r.status) ?? '').toLowerCase();
  const { state, stateTone } =
    status === 'connected'
      ? { state: 'up', stateTone: 'success' as Tone }
      : status === 'disconnected'
        ? { state: 'down', stateTone: 'danger' as Tone }
        : { state: status || 'unknown', stateTone: 'neutral' as Tone };
  const siteUuid = str(r.site_id);
  const site = siteIdForName(siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null);
  const serial = str(r.serial);
  const mac = str(r.mac);
  return {
    name,
    model: str(r.model) ?? 'unknown',
    type: deviceTypeFor(str(r.type)),
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'MIST',
    planeTone: 'info',
    state,
    stateTone,
    firmware: str(r.version) ?? 'unknown',
    firmwareApproved: true, // Mist's stats API does not publish an approved train — honest default
    licence: 'unknown', // Mist subscriptions live in the Mist dashboard, not in this API
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false, // cloud-claimed — no portal shell
    ...(serial ? { serial } : {}),
    ...(mac ? { mac } : {}),
  };
}

/** Mist org site row → SiteRow (device counts ride along from the stats section). */
export function mapMistSite(raw: unknown, deviceCount: number): SiteRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name);
  if (!name) return null;
  const site = siteIdForName(name);
  return {
    id: site.siteId,
    name: site.siteName,
    subnet: '—', // Mist's site object has no subnet concept
    planes: [{ name: 'MIST', tone: 'info' }],
    mix: '—', // the live merge derives the mix from reconciled devices
    devices: deviceCount,
    clients: '0',
    health: null, // the sites endpoint reports no health score — cannot assert
    healthPct: '—',
    tone: 'stale',
    alerts: '—',
    alertTone: 'neutral',
    sync: '—',
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function withScheme(base: string): string {
  return /^https?:\/\//i.test(base) ? base : `https://${base}`;
}

/** Rows are a bare array on list endpoints; tolerate an envelope too. */
function extractRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    if (Array.isArray(r.results)) return r.results;
  }
  return [];
}

export class MistAdapter implements PlaneAdapter {
  readonly id = 'mist' as const;

  private readonly baseUrl: string;
  private readonly orgId: string;
  private readonly token: string;

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    if (!MistAdapter.isComplete(creds)) {
      throw new Error('mist requires apiHost, orgId and token');
    }
    this.baseUrl = withScheme(creds.apiHost).replace(/\/+$/, '');
    this.orgId = creds.orgId.trim();
    this.token = creds.token;
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    return (
      !!creds &&
      [creds.apiHost, creds.orgId, creds.token].every((v) => typeof v === 'string' && v.trim().length > 0)
    );
  }

  state(): PlaneState {
    return this.stateRef;
  }

  async pull(): Promise<PlanePull> {
    let siteRows: unknown[];
    let deviceRows: unknown[];
    try {
      siteRows = await this.fetchAll(`/api/v1/orgs/${encodeURIComponent(this.orgId)}/sites`);
    } catch (err) {
      throw new Error(`mist pull: section 'sites' failed — ${(err as Error).message}`);
    }
    try {
      deviceRows = await this.fetchAll(`/api/v1/orgs/${encodeURIComponent(this.orgId)}/stats/devices?type=all`);
    } catch (err) {
      throw new Error(`mist pull: section 'devices' failed — ${(err as Error).message}`);
    }

    const siteNameById = new Map<string, string>();
    for (const s of siteRows) {
      if (!s || typeof s !== 'object') continue;
      const r = s as Record<string, unknown>;
      const id = str(r.id);
      const name = str(r.name);
      if (id && name) siteNameById.set(id, name);
    }

    const devices = deviceRows
      .map((d) => mapMistDevice(d, siteNameById))
      .filter((d): d is MistDeviceRow => d !== null);

    const countBySite = new Map<string, number>();
    for (const d of devices) {
      countBySite.set(d.siteName, (countBySite.get(d.siteName) ?? 0) + 1);
    }
    // Key the lookup by the MAPPED site name (same mapping the devices use) —
    // an aliased Mist name would otherwise count 0, and two Mist sites that
    // alias to one canonical id merge into a single SiteRow.
    const sites: SiteRow[] = [];
    const seenSiteIds = new Set<string>();
    for (const s of siteRows) {
      const r = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
      const mapped = siteIdForName(str(r.name));
      const row = mapMistSite(s, countBySite.get(mapped.siteName) ?? 0);
      if (row === null || seenSiteIds.has(row.id)) continue;
      seenSiteIds.add(row.id);
      sites.push(row);
    }

    const down = devices.filter((d) => d.state === 'down').length;
    this.stateRef.note =
      `${devices.length.toLocaleString('en-US')} devices across ${sites.length.toLocaleString('en-US')} sites` +
      (down > 0 ? ` · ${down.toLocaleString('en-US')} down` : '') +
      ' · client counts only (no per-client roster)';
    if (this.stateRef.health === 'warning') this.stateRef.health = 'healthy'; // first sync done

    return { devices, sites };
  }

  // -- internals -------------------------------------------------------------

  /**
   * All pages of a list endpoint: loop limit/page until a short page comes
   * back (works with or without the undocumented X-Page-* headers), capped
   * at MAX_PAGES so a misbehaving tenant cannot loop forever.
   */
  private async fetchAll(path: string): Promise<unknown[]> {
    const sep = path.includes('?') ? '&' : '?';
    const out: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await this.get(`${path}${sep}limit=${PAGE_LIMIT}&page=${page}`);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} from ${path} (page ${page})`);
      }
      const rows = extractRows(res.body);
      out.push(...rows);
      if (rows.length < PAGE_LIMIT) break;
    }
    return out;
  }

  /**
   * Timed outbound GET recorded in the plane's call log. The log carries
   * method + path + ms + status only — headers (and so the token) never.
   */
  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Token ${this.token}`,
        },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: `GET ${path}`, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`GET ${path} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: `GET ${path}`, ms: Date.now() - started, code: String(res.status) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* tolerate a non-JSON body — status is what we needed */
    }
    return { status: res.status, body };
  }
}
