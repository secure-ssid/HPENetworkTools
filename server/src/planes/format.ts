/**
 * Plane-agnostic derivation helpers.
 *
 * These turn what a vendor sent into what the UI vocabulary expects: a site
 * name into a canonical site id, a timestamp in whichever of three encodings
 * arrived into epoch ms, a severity word into P1/P2/P3, an age in ms into
 * '12m'. None of them know which plane is asking.
 *
 * They were written in central.ts, so Mist, UXI and AOS-8 imported them from
 * there. Together with the transport primitives (now in transport.ts) that was
 * the entire reason those adapters depended on the Central adapter at all.
 * With both sets moved out, no plane adapter imports another plane adapter.
 *
 * `str` and `num` are exported because every adapter's field readers are built
 * on them and each was otherwise going to keep its own copy. They answer null
 * rather than a default, which is the whole point: a caller needs to be able to
 * tell "the vendor omitted this" from "the vendor said zero" — those are
 * different facts and the honesty rules require reporting them differently.
 */

import { siteDisplayName, siteIdFor, type Sev, type SiteId } from '@hpe/shared';

// ---------------------------------------------------------------------------
// Defensive field readers — unknown/extra fields ignored, missing → null
// ---------------------------------------------------------------------------

export function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0 && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

// ---------------------------------------------------------------------------
// Site identity
// ---------------------------------------------------------------------------

/**
 * LOCAL GAP (do not fix in shared/): shared SiteId is a closed union over the
 * fixture sites, so it cannot name a site only a real plane knows about. We
 * mint 'ext-<slug>' ids locally and cast. Consumers must treat SiteId as an
 * opaque string; these ids never collide with the canonical ones.
 */
export function externalSiteId(name: string): SiteId {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `ext-${slug || 'unknown'}` as SiteId;
}

/**
 * Resolve a plane-reported site name to the canonical site join. Known
 * aliases get the canonical id + authored display name; unknown names keep
 * the plane's own display string under a generated 'ext-*' id; absent names
 * land on the 'multiple' pseudo-site (its documented purpose).
 */
export function siteIdForName(name: string | null): { siteId: SiteId; siteName: string } {
  if (name) {
    const known = siteIdFor(name);
    if (known) return { siteId: known, siteName: siteDisplayName(known) };
    return { siteId: externalSiteId(name), siteName: name };
  }
  return { siteId: 'multiple', siteName: siteDisplayName('multiple') };
}

// ---------------------------------------------------------------------------
// Approved firmware map ('cx=10.13,ap=10.6')
// ---------------------------------------------------------------------------

export type ApprovedFirmwareMap = [family: string, prefix: string][];

export function parseApprovedFirmware(spec: string | undefined): ApprovedFirmwareMap {
  if (!spec) return [];
  const out: ApprovedFirmwareMap = [];
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const family = part.slice(0, eq).trim().toLowerCase();
    const prefix = part.slice(eq + 1).trim();
    if (family && prefix) out.push([family, prefix]);
  }
  return out;
}

/**
 * Honest default true: without an operator-declared train we cannot know a
 * firmware is unapproved, and flagging everything would be noise.
 */
export function firmwareIsApproved(
  type: string,
  model: string,
  firmware: string,
  approved: ApprovedFirmwareMap,
): boolean {
  if (approved.length === 0 || firmware === 'unknown') return true;
  const haystack = `${type} ${model}`.toLowerCase();
  const entry = approved.find(([family]) => haystack.includes(family));
  if (!entry) return true;
  return firmware.startsWith(entry[1]);
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Relative age string in the fixtures' vocabulary: '45s', '12m', '6h', '2d'. */
export function ageString(thenMs: number, nowMs: number = Date.now()): string {
  const sec = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/** Session-length display: '4h 12m', '37m', '50s'. */
export function durationString(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const hr = Math.floor(sec / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (hr > 0) return `${hr}h ${min}m`;
  if (min > 0) return `${min}m`;
  return `${sec}s`;
}

/** Epoch seconds, epoch ms or ISO string → epoch ms; anything else → null. */
export function parseTimestamp(v: unknown): number | null {
  const n = num(v);
  if (n !== null) {
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return null;
  }
  const s = str(v);
  if (s) {
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/** Vendor severity vocabulary → the design's P1/P2/P3. */
export function sevFor(raw: string | null): Sev {
  const s = (raw ?? '').toLowerCase();
  if (/crit|emerg|major|alert|p1/.test(s)) return 'P1';
  if (/warn|minor|p2/.test(s)) return 'P2';
  return 'P3';
}
