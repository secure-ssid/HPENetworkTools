import type { SsidObject } from '@hpe/shared';

/** The complete, read-only identity carried from a WLAN inventory row to
 * Configure. Every field is needed: name alone is not unique across planes,
 * VLANs, or target scopes. */
export type SsidDeepLink = {
  plane: 'CENTRAL' | 'MIST';
  name: string;
  vlan: string;
  targets: string;
};

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

/** Normalize only presentation whitespace and the two supported plane labels.
 * It intentionally does not coerce a multi-plane or unsupported inventory row
 * into a writable destination. */
export function normalizeSsidDeepLink(value: {
  plane: unknown;
  name: unknown;
  vlan: unknown;
  targets: unknown;
}): SsidDeepLink | null {
  const plane = text(value.plane)?.toUpperCase();
  const name = text(value.name);
  const vlan = text(value.vlan);
  const targets = text(value.targets);
  if ((plane !== 'CENTRAL' && plane !== 'MIST') || !name || !vlan || !targets) return null;
  return { plane, name, vlan, targets };
}

/** Builds the single supported WLAN editor URL with URLSearchParams so row
 * values such as ampersands and Unicode scope separators remain exact. */
export function buildSsidDeepLink(row: SsidObject, plane?: SsidDeepLink['plane']): string | null {
  if (plane && !row.plane.split('+').map((value) => value.trim().toUpperCase()).includes(plane)) return null;
  const identity = normalizeSsidDeepLink({ ...row, plane: plane ?? row.plane });
  if (!identity) return null;
  const params = new URLSearchParams({ edit: 'ssid', ...identity });
  return `/configure?${params.toString()}`;
}

/** Parses only a complete, non-ambiguous `edit=ssid` contract. Repeated
 * identity fields are deliberately malformed rather than silently picked. */
export function parseSsidDeepLink(search: string | URLSearchParams): SsidDeepLink | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const one = (key: string): string | null => {
    const values = params.getAll(key);
    return values.length === 1 ? values[0]! : null;
  };
  if (one('edit') !== 'ssid') return null;
  return normalizeSsidDeepLink({
    plane: one('plane'),
    name: one('name'),
    vlan: one('vlan'),
    targets: one('targets'),
  });
}

/** Resolves the query only against the data Configure actually loaded. A
 * missing or duplicate identity has no writable target and returns null. */
export function locateSsidDeepLink(rows: readonly SsidObject[], identity: SsidDeepLink): SsidObject | null {
  const matches = rows.filter((row) => {
    const candidate = normalizeSsidDeepLink({ ...row, plane: identity.plane });
    const rowPlanes = row.plane.split('+').map((plane) => plane.trim().toUpperCase());
    return (
      candidate !== null &&
      rowPlanes.includes(identity.plane) &&
      candidate.plane === identity.plane &&
      candidate.name === identity.name &&
      candidate.vlan === identity.vlan &&
      candidate.targets === identity.targets
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}
