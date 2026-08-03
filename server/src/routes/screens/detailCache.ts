/**
 * On-demand per-object detail reads, with a cache and a budget.
 *
 * Detail panes fetch from the vendor when opened rather than on every poll,
 * because the per-object call cost is what exhausts a rate limit. The cache
 * makes reopening a pane free for a short window; the budget stops one slow
 * plane from holding a request open indefinitely.
 *
 * A read that fails is reported as FAILED. It is never rendered as a section
 * with nothing in it — an empty pane and an unread pane look identical to an
 * operator, and only one of them means the device is fine.
 */

import { PLANE_LABEL } from '../../services/reconcile';
import { normalizeMac } from '../../planes/clearpass';
import { type Response } from 'express';
import { registry } from '../../planes/registry';
import { type PlaneId } from '../../planes/types';
import {
  planeIdForLabel,
  type ReconciledDeviceRow,
} from '../../services/reconcile';
import { reportedValue } from './context';
import { liveMerged } from './liveCore';
import {
  type ClientDetailLive,
  type ClientDetailSection,
  type ClientRow,
  type DetailFetchState,
  type DetailSource,
  type DeviceDetailKind,
  type DeviceDetailLive,
  type DeviceDetailSection,
  type DeviceType,
  type Plane,
  type SiteId,
  type SiteRow,
  type SiteTopologyLive,
  type SiteTopologySection,
} from '@hpe/shared';

/** Detail freshness. Longer than the 60s poll on purpose: these are per-object
 *  calls against a metered plane, and a drawer left open through a refresh
 *  must not turn into one call per poll. */
export const DETAIL_TTL_MS = 90_000;

/** Physical wiring changes on the timescale of a maintenance window, not a
 *  poll, so the site graph is cached far longer than RF numbers. */
export const TOPOLOGY_TTL_MS = 300_000;

/** Backstop only — adapters carry their own HTTP timeouts. This exists so a
 *  hung socket cannot hold a screen request open forever. */
export const DETAIL_TIMEOUT_MS = 10_000;

/** Bounded so a long-lived server cannot accumulate one entry per MAC seen. */
export const DETAIL_CACHE_MAX = 256;

export const detailCache = new Map<string, { at: number; value: unknown; failed: boolean }>();

/**
 * How long a FAILED read stays cached. Much shorter than the success TTL, and
 * deliberately not zero.
 *
 * attemptDetail turns a throw or a timeout into a resolved "failed" payload,
 * which is the honest thing to hand a screen. Caching that payload for the
 * full success TTL is not: it takes something that was true for one instant
 * and keeps asserting it for the next ninety seconds — five minutes for
 * topology. The operator sees the failure, hits refresh, and is served the
 * same failure straight back out of memory with nothing retried, long after
 * the plane recovered. A momentary truth becomes a lasting falsehood, which is
 * the one thing this cache must not manufacture.
 *
 * Zero would be worse. A plane that is genuinely down would then take a fresh
 * call for every request, which is the stampede the cache exists to stop. Ten
 * seconds prevents that and still lets a refresh mean something.
 *
 * A cached `null` keeps the long TTL: it means no plane can answer this at
 * all, which is a structural fact rather than a transient fault.
 */
export const DETAIL_FAILURE_TTL_MS = 10_000;

/** A payload with any section marked 'failed' is a fault, not data. */
export function isFailedRead(value: unknown): boolean {
  const sections = (value as { source?: { sections?: Record<string, unknown> } } | null)?.source?.sections;
  if (!sections || typeof sections !== 'object') return false;
  return Object.values(sections).some((state) => state === 'failed');
}

export const detailInflight = new Map<string, Promise<unknown>>();

/** Test seam: forget every cached detail read. Never called by a route. */
export function resetDetailCache(): void {
  detailCache.clear();
  detailInflight.clear();
}

export function trimDetailCache(): void {
  while (detailCache.size > DETAIL_CACHE_MAX) {
    const oldest = detailCache.keys().next();
    if (oldest.done) return;
    detailCache.delete(oldest.value);
  }
}

/** Re-stamp a cached payload as cached WITHOUT mutating the cached object —
 *  it is handed to every subsequent reader. */
export function asCached<T extends { source: DetailSource<string> }>(value: T | null): T | null {
  if (value === null) return null;
  return { ...value, source: { ...value.source, cached: true } };
}

/**
 * TTL + single-flight around one per-object read.
 *
 * A cached `null` is cached too: "this plane cannot answer" is an answer, and
 * re-asking every request would defeat the point of the gate.
 */
export function cachedDetail<T extends { source: DetailSource<string> }>(
  key: string,
  ttlMs: number,
  run: () => Promise<T | null>,
): Promise<T | null> {
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < (hit.failed ? Math.min(DETAIL_FAILURE_TTL_MS, ttlMs) : ttlMs)) {
    return Promise.resolve(asCached(hit.value as T | null));
  }
  const flying = detailInflight.get(key) as Promise<T | null> | undefined;
  if (flying) return flying;
  const call = run()
    .then((value) => {
      detailCache.set(key, { at: Date.now(), value, failed: isFailedRead(value) });
      trimDetailCache();
      return value;
    })
    .finally(() => detailInflight.delete(key));
  detailInflight.set(key, call as Promise<unknown>);
  return call;
}

export const DETAIL_DEADLINE = { ok: false as const };

/**
 * Run one adapter call so it can only ever resolve. A throw or a hang becomes
 * an explicit 'failed' payload — NOT a null, because null means "never asked"
 * and the two must not read the same on screen.
 */
export async function attemptDetail<T>(
  call: () => Promise<T | null>,
  onFailure: (note: string) => T,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<typeof DETAIL_DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DETAIL_DEADLINE), DETAIL_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const settled = await Promise.race([
      call().then((value) => ({ ok: true as const, value })),
      deadline,
    ]);
    if (!settled.ok) {
      return onFailure(`the detail read did not answer within ${Math.round(DETAIL_TIMEOUT_MS / 1000)}s`);
    }
    return settled.value;
  } catch (err) {
    return onFailure(detailErrorText(err));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The adapter's own words, trimmed. Adapters never put credentials in an
 *  error message; the length cap keeps a stack trace out of the payload. */
export function detailErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const one = text.split('\n')[0]!.trim();
  return one.length > 200 ? `${one.slice(0, 197)}…` : one || 'the detail read failed';
}

/**
 * Is this plane out of calls for today?
 *
 * A plane with no stored budget asserts no limit, so it is never gated. When
 * there IS a budget and it is spent, the honest move is to not call and say
 * why — a detail payload with no sections attempted plus that sentence.
 */
export function detailBudgetNote(id: PlaneId): string | null {
  const state = registry.state(id);
  const budget = state.callBudget;
  if (budget === null || budget === undefined) return null;
  if (state.callsToday < budget) return null;
  return `${PLANE_LABEL[id]} has spent its stored daily call budget (${state.callsToday}/${budget}) — no per-object detail read was issued`;
}

/** The registry plane behind a display label, or null for a label the portal
 *  adapts nothing for ('THIRD-PARTY'). */
export function detailPlaneFor(label: Plane | null | undefined): PlaneId | null {
  return label ? planeIdForLabel(label) ?? null : null;
}

/** Last-resort guard: a detail read is an enhancement, never a reason for a
 *  screen request to fail. */
export function neverThrows<T>(p: Promise<T | null>): Promise<T | null> {
  return p.catch(() => null);
}

export const CLIENT_DETAIL_SECTIONS: readonly ClientDetailSection[] = [
  'rssi',
  'tput',
  'roams',
  'timeline',
  'usageSeries',
];

export function sectionMap<S extends string>(
  sections: readonly S[],
  state: DetailFetchState,
): Partial<Record<S, DetailFetchState>> {
  const out: Partial<Record<S, DetailFetchState>> = {};
  for (const s of sections) out[s] = state;
  return out;
}

/**
 * A detail payload that carries no data and says why.
 *
 * `attempted: false` leaves `sections` empty, which the contract defines as
 * 'not-fetched' for every section — the shape for "we chose not to ask".
 * `attempted: true` marks them 'failed' — "we asked and it broke".
 */
export function clientDetailStub(
  mac: string,
  plane: PlaneId,
  note: string,
  attempted: boolean,
): ClientDetailLive {
  return {
    mac,
    source: {
      plane,
      at: new Date().toISOString(),
      sections: attempted ? sectionMap(CLIENT_DETAIL_SECTIONS, 'failed') : {},
      note,
    },
  };
}

/** An AP has radios and WLANs; a switch or gateway has ports. Asking a switch
 *  for radios spends a call on a guaranteed 404. */
export function deviceDetailSections(kind: DeviceDetailKind): readonly DeviceDetailSection[] {
  return kind === 'ap' ? (['radios', 'wlans'] as const) : (['ports'] as const);
}

export function deviceDetailStub(
  serial: string,
  kind: DeviceDetailKind,
  plane: PlaneId,
  note: string,
  attempted: boolean,
): DeviceDetailLive {
  return {
    serial,
    kind,
    source: {
      plane,
      at: new Date().toISOString(),
      sections: attempted ? sectionMap(deviceDetailSections(kind), 'failed') : {},
      note,
    },
  };
}

export const TOPOLOGY_SECTIONS: readonly SiteTopologySection[] = ['nodes', 'links'];

export function topologyStub(
  siteKey: string,
  plane: PlaneId,
  note: string,
  attempted: boolean,
): SiteTopologyLive {
  return {
    siteId: siteKey,
    source: {
      plane,
      at: new Date().toISOString(),
      sections: attempted ? sectionMap(TOPOLOGY_SECTIONS, 'failed') : {},
      note,
    },
  };
}

/** Only these three device families have per-object subresources worth a call;
 *  a controller/sensor/policy row asks for nothing. */
export const DEVICE_DETAIL_KIND: Partial<Record<DeviceType, DeviceDetailKind>> = {
  ap: 'ap',
  switch: 'switch',
  gateway: 'gateway',
};

/**
 * Per-client detail for the ONE client whose drawer is opening.
 *
 * Gates, in order: a client with no MAC cannot be asked about; a label with no
 * registry plane behind it has no adapter; an adapter without the capability
 * claims nothing; a plane out of budget is told about rather than called.
 */
export function liveClientDetail(client: ClientRow | null | undefined): Promise<ClientDetailLive | null> {
  if (!client || !reportedValue(client.mac)) return Promise.resolve(null);
  const planeId = detailPlaneFor(client.plane);
  if (!planeId) return Promise.resolve(null);
  const adapter = registry.get(planeId);
  const read = adapter.clientDetail;
  if (typeof read !== 'function') return Promise.resolve(null);
  const mac = client.mac;
  const budget = detailBudgetNote(planeId);
  if (budget) return Promise.resolve(clientDetailStub(mac, planeId, budget, false));
  return neverThrows(
    cachedDetail(`client:${planeId}:${normalizeMac(mac)}:${client.medium}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => read.call(adapter, mac, client.medium),
        (note) => clientDetailStub(mac, planeId, note, true),
      ),
    ),
  );
}

/** Per-device detail for the ONE device whose page is opening. */
export function liveDeviceDetail(device: ReconciledDeviceRow | null): Promise<DeviceDetailLive | null> {
  if (!device || !reportedValue(device.serial)) return Promise.resolve(null);
  const kind = DEVICE_DETAIL_KIND[device.type];
  if (!kind) return Promise.resolve(null);
  const planeId = detailPlaneFor(device.plane);
  if (!planeId) return Promise.resolve(null);
  const adapter = registry.get(planeId);
  const read = adapter.deviceDetail;
  if (typeof read !== 'function') return Promise.resolve(null);
  const serial = device.serial!;
  const budget = detailBudgetNote(planeId);
  if (budget) return Promise.resolve(deviceDetailStub(serial, kind, planeId, budget, false));
  return neverThrows(
    cachedDetail(`device:${planeId}:${serial}:${kind}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => read.call(adapter, serial, kind),
        (note) => deviceDetailStub(serial, kind, planeId, note, true),
      ),
    ),
  );
}

/**
 * The key a plane can join its own site records on.
 *
 * The portal's SiteId is the PORTAL's: central.ts mints 'ext-<slug>' from the
 * plane's site NAME (siteIdForName) and keeps no plane id, so this route has
 * no numeric id to pass. A portal id that is already all digits came from a
 * plane and is passed through unchanged; otherwise the site NAME is the only
 * key both sides hold, and the adapter owns the name -> id join because the
 * adapter is the side that made it.
 */
export function planeSiteKey(site: SiteRow): string {
  const id = String(site.id);
  return /^\d+$/.test(id) ? id : site.name;
}

/** One named plane's link topology for ONE site, cached across every screen. */
export function livePlaneSiteTopology(site: SiteRow | null, planeId: PlaneId): Promise<SiteTopologyLive | null> {
  if (!site) return Promise.resolve(null);
  const siteKey = planeSiteKey(site);
  if (!reportedValue(siteKey)) return Promise.resolve(null);
  const adapter = registry.get(planeId);
  const read = adapter.siteTopology;
  if (typeof read !== 'function') return Promise.resolve(null);
  const budget = detailBudgetNote(planeId);
  if (budget) return Promise.resolve(topologyStub(siteKey, planeId, budget, false));
  return neverThrows(
    cachedDetail(`topology:${planeId}:${siteKey}`, TOPOLOGY_TTL_MS, () =>
      attemptDetail(
        () => read.call(adapter, siteKey),
        (note) => topologyStub(siteKey, planeId, note, true),
      ),
    ),
  );
}

/**
 * The first claiming plane's link topology for ONE site.
 *
 * A site can be claimed by several planes; the first badge whose adapter can
 * actually answer wins, rather than assuming Central. The result is cached per
 * plane+site, so the site page, a device page and a client drawer at the same
 * site share one read.
 */
export function liveSiteTopology(site: SiteRow | null): Promise<SiteTopologyLive | null> {
  if (!site) return Promise.resolve(null);
  for (const badge of site.planes) {
    const planeId = detailPlaneFor(badge.name);
    if (!planeId) continue;
    const adapter = registry.get(planeId);
    if (typeof adapter.siteTopology === 'function') return livePlaneSiteTopology(site, planeId);
  }
  return Promise.resolve(null);
}

/** The site row a live object belongs to, for the topology read. */
export function liveSiteById(id: SiteId | null | undefined): SiteRow | null {
  if (!id) return null;
  return liveMerged().sites.find((s) => s.id === id) ?? null;
}

/** Answer an async screen request without letting a rejection hang the socket. */
export function settle(res: Response, work: Promise<void>): void {
  void work.catch((err) => {
    if (!res.headersSent) res.status(500).json({ error: detailErrorText(err) });
  });
}
