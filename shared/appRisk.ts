/**
 * shared/appRisk.ts — DPI application visibility: types + the pure
 * normalizer/aggregator for a site's application table.
 *
 * The endpoint this serves (verified shape):
 *
 *   GET /network-monitoring/v1/applications
 *     REQUIRES site_id + start/end ISO; the window is capped at 7 days (a
 *     wider one 400s with a singular {error} body); pages on limit=200&offset.
 *     Rows: { name, id, risk, state, rxBytes, txBytes, categories[],
 *     applicationHostType, destLocation[], experience, lastUsedTime (string
 *     epoch ms), tlsVersion, certificateExpiryDate }.
 *
 * What the row fields are worth, verified against a live tenant:
 *
 *   - `risk` arrives in a wider vocabulary than the portal's five buckets
 *     ('high', 'medium', 'very_low', 'trusted', 'not_evaluated', …). The
 *     aliases below fold it into the worst-first bucket order; the normalizer
 *     is idempotent so re-normalizing a row is a no-op.
 *   - `experience` is a DEAD field (all-zero on every row) and
 *     `tlsVersion`/`certificateExpiryDate` arrive empty. They are kept on the
 *     row as nulls so a screen can say "not reported by the plane" — they
 *     must never render as a real 0 score or a real 1970 date.
 *   - Byte totals are DPI estimates. They rank applications against each
 *     other; they are not a measurement of what crossed the wire, and the UI
 *     must say so (DPI_BYTES_ARE_ESTIMATES).
 *
 * Pure: same rows in, same aggregates out, no clock, no environment.
 */

import type { DetailSource } from './types';
import type { TrendWindow } from './trends';

// ---------------------------------------------------------------------------
// Risk buckets
// ---------------------------------------------------------------------------

/** The portal's application-risk vocabulary. */
export type DpiRiskBucket = 'suspicious' | 'moderate' | 'low' | 'trustworthy' | 'unknown';

/** Worst-first — the order a watchlist renders in. */
export const RISK_BUCKET_ORDER: readonly DpiRiskBucket[] = [
  'suspicious',
  'moderate',
  'low',
  'trustworthy',
  'unknown',
];

/**
 * The plane's risk words folded into the buckets. Keys are lowercase with
 * underscores preserved; both 'very_high' and its spaced spelling are listed
 * because the vocabulary has drifted between releases. The bucket names map
 * to themselves, which is what makes the normalizer idempotent.
 */
const RISK_ALIASES: Record<string, DpiRiskBucket> = {
  suspicious: 'suspicious',
  high: 'suspicious',
  very_high: 'suspicious',
  'very high': 'suspicious',
  moderate: 'moderate',
  medium: 'moderate',
  low: 'low',
  very_low: 'low',
  'very low': 'low',
  trustworthy: 'trustworthy',
  trusted: 'trustworthy',
  safe: 'trustworthy',
  unknown: 'unknown',
  not_evaluated: 'unknown',
  'not evaluated': 'unknown',
};

/**
 * One risk word → its bucket. Anything the plane says that is not listed
 * lands in 'unknown' — never a guess at a better-looking bucket. Idempotent:
 * feeding a bucket back through returns the same bucket.
 */
export function normalizeRiskBucket(raw: string | null | undefined): DpiRiskBucket {
  const key = (raw ?? '').trim().toLowerCase();
  return RISK_ALIASES[key] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// One normalized application row
// ---------------------------------------------------------------------------

export interface SiteAppRow {
  /** The plane's application id (falls back to the name when the row omits it). */
  id: string;
  name: string;
  /** The plane's own risk word, verbatim ('high') — kept so the normalized
   *  bucket is never the only record of what the plane said. */
  riskRaw: string;
  risk: DpiRiskBucket;
  /** The plane's state word, verbatim; '' when the row carried none. */
  state: string;
  rxBytes: number | null;
  txBytes: number | null;
  /** rx+tx when at least one side was reported; null when neither was —
   *  a ranking row without a number, not a zero. */
  totalBytes: number | null;
  /** Category words as the plane sent them, trimmed, empties dropped. */
  categories: string[];
  applicationHostType: string | null;
  destLocation: string[];
  /** Central's app-experience score. DEAD on verified tenants (all-zero), so
   *  an all-zero/empty reading normalizes to null = "not reported", never a
   *  rendered 0. */
  experience: number | null;
  /** ISO instant the app was last seen, from lastUsedTime (string epoch ms).
   *  0/unparseable → null, never 1970. */
  lastUsedAt: string | null;
  /** DEAD on verified tenants (empty) — null = "not reported". */
  tlsVersion: string | null;
  /** ISO expiry from certificateExpiryDate. DEAD on verified tenants (empty);
   *  unparseable → null. */
  certificateExpiryAt: string | null;
}

/** A bare number, or null — the plane sends its statistics as strings. */
function appNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const n = Number(raw.trim());
    return raw.trim().length > 0 && Number.isFinite(n) ? n : null;
  }
  return null;
}

/** An instant from epoch ms (number/numeric string) or an ISO string. */
function appInstant(raw: unknown): string | null {
  let ms: number | null = null;
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim()))) {
    ms = appNumber(raw);
  } else if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    ms = Number.isFinite(parsed) ? parsed : null;
  }
  return ms !== null && ms > 0 ? new Date(ms).toISOString() : null;
}

/** Trimmed, non-empty strings out of an array field; anything else → []. */
function appStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
}

/**
 * The experience score, or null. The field is verified dead (all-zero), and
 * a rendered 0 reads as "terrible experience" — the one claim the plane is
 * NOT making. Zero and unparseable both normalize to "not reported".
 */
function appExperience(raw: unknown): number | null {
  let score: number | null = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    score = appNumber((raw as Record<string, unknown>).score);
  } else {
    score = appNumber(raw);
  }
  return score !== null && score > 0 ? score : null;
}

/** One DPI row → SiteAppRow, or null when the row names nothing (junk). */
export function normalizeSiteApp(raw: unknown): SiteAppRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const strField = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : typeof v === 'number' ? String(v) : null;
  const name = strField(r.name) ?? strField(r.id);
  if (!name) return null;
  const rxBytes = appNumber(r.rxBytes);
  const txBytes = appNumber(r.txBytes);
  return {
    id: strField(r.id) ?? name,
    name,
    riskRaw: strField(r.risk) ?? '',
    risk: normalizeRiskBucket(strField(r.risk)),
    state: strField(r.state) ?? '',
    rxBytes,
    txBytes,
    totalBytes: rxBytes === null && txBytes === null ? null : (rxBytes ?? 0) + (txBytes ?? 0),
    categories: appStringList(r.categories),
    applicationHostType: strField(r.applicationHostType),
    destLocation: appStringList(r.destLocation),
    experience: appExperience(r.experience),
    lastUsedAt: appInstant(r.lastUsedTime),
    tlsVersion: strField(r.tlsVersion),
    certificateExpiryAt: appInstant(r.certificateExpiryDate),
  };
}

// ---------------------------------------------------------------------------
// The watchlist split
// ---------------------------------------------------------------------------

/** The plane's words for "we could not classify this application". */
export const UNCLASSIFIED_CATEGORY_WORDS: readonly string[] = ['', 'not available', 'unknown', 'n/a', 'none'];

/** True for a category word that says nothing ('unknown', 'n/a', …). */
export function isUnclassifiedCategory(category: string): boolean {
  return UNCLASSIFIED_CATEGORY_WORDS.includes(category.trim().toLowerCase());
}

/** True when EVERY category the app carries is a non-answer (or it carries
 *  none): the plane saw the traffic but could not say what it was. */
export function appIsUnclassified(app: SiteAppRow): boolean {
  return app.categories.every(isUnclassifiedCategory);
}

/** The watchlist is the flagged subset: 'suspicious' or 'moderate' risk. */
export function appIsFlagged(app: SiteAppRow): boolean {
  return app.risk === 'suspicious' || app.risk === 'moderate';
}

export interface AppWatchlistSplit {
  /** Flagged apps the plane could not classify — the investigation queue. */
  unclassified: SiteAppRow[];
  /** Flagged apps with at least one real category. */
  known: SiteAppRow[];
}

/** Split the flagged apps into unclassified vs known, input order preserved. */
export function watchlistSplit(rows: readonly SiteAppRow[]): AppWatchlistSplit {
  const out: AppWatchlistSplit = { unclassified: [], known: [] };
  for (const app of rows) {
    if (!appIsFlagged(app)) continue;
    (appIsUnclassified(app) ? out.unclassified : out.known).push(app);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/**
 * The honesty caveat the DPI screen must show alongside any byte figure.
 * DPI samples and infers; the totals rank applications against each other
 * but are not wire measurements.
 */
export const DPI_BYTES_ARE_ESTIMATES =
  'DPI byte totals are estimates — read as a ranking, not a measurement';

/** Rows ranked by total bytes, largest first; unreported totals last, then
 *  alphabetical so the order is deterministic. */
export function byBytesDesc(rows: readonly SiteAppRow[]): SiteAppRow[] {
  return [...rows].sort((a, b) => (b.totalBytes ?? -1) - (a.totalBytes ?? -1) || a.name.localeCompare(b.name));
}

/** Per-bucket app counts, every bucket present (0 included) so a renderer
 *  never re-keys the map. */
export function riskBucketCounts(rows: readonly SiteAppRow[]): Record<DpiRiskBucket, number> {
  const out: Record<DpiRiskBucket, number> = { suspicious: 0, moderate: 0, low: 0, trustworthy: 0, unknown: 0 };
  for (const app of rows) out[app.risk] += 1;
  return out;
}

/** The synthetic bucket for apps whose categories are all non-answers. */
export const UNCATEGORIZED_CATEGORY = 'Uncategorized';

export interface AppCategoryShare {
  category: string;
  /** Distinct apps carrying this category. */
  apps: number;
  /** Summed totalBytes of those apps. */
  bytes: number;
  /**
   * Share of the LARGEST category's bytes (0..1, largest = 1) — the bar
   * length. NEVER a percent of total: an app's bytes count toward every
   * category it carries, so percents of the total would sum past 100 and
   * read as a breakdown of the traffic, which this is not.
   */
  share: number;
}

/**
 * Category rollup: an app's bytes sum into EVERY category it carries (an app
 * tagged ['Streaming','Web'] counts in both). Apps with no real category
 * roll into UNCATEGORIZED_CATEGORY. Sorted by bytes desc, name asc.
 */
export function rollupAppCategories(rows: readonly SiteAppRow[]): AppCategoryShare[] {
  const buckets = new Map<string, { apps: number; bytes: number }>();
  for (const app of rows) {
    const real = app.categories.filter((c) => !isUnclassifiedCategory(c));
    const cats = real.length > 0 ? real : [UNCATEGORIZED_CATEGORY];
    for (const category of new Set(cats)) {
      const bucket = buckets.get(category) ?? { apps: 0, bytes: 0 };
      bucket.apps += 1;
      bucket.bytes += app.totalBytes ?? 0;
      buckets.set(category, bucket);
    }
  }
  const sorted = [...buckets.entries()]
    .map(([category, b]) => ({ category, apps: b.apps, bytes: b.bytes, share: 0 }))
    .sort((a, b) => b.bytes - a.bytes || a.category.localeCompare(b.category));
  const max = sorted.length > 0 ? sorted[0]!.bytes : 0;
  for (const row of sorted) row.share = max > 0 ? row.bytes / max : 0;
  return sorted;
}

// ---------------------------------------------------------------------------
// The on-demand payload envelope (same *Live contract as ClientDetailLive)
// ---------------------------------------------------------------------------

/** Sections of a site applications read — one endpoint call. */
export type SiteAppsSection = 'apps';

/**
 * A site's DPI application table, fetched on demand for ONE site over ONE
 * window. Absent `apps` = not fetched; present-and-empty = the plane
 * authoritatively reported no application traffic in the window.
 */
export interface SiteApplicationsLive {
  /** The plane's site id the read was issued for. */
  siteId: string;
  /** The validated window actually queried. */
  window: TrendWindow;
  /** Ranked by total bytes (byBytesDesc) when present. */
  apps?: SiteAppRow[];
  /** True when the paged walk did not finish — the table is a prefix of the
   *  real ranking, not the whole of it. */
  truncated?: boolean;
  source: DetailSource<SiteAppsSection>;
}
