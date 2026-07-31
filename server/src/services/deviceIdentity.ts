import type { Plane } from '@hpe/shared';

export interface DeviceIdentity {
  plane?: string;
  serial?: string;
}

export interface DeviceIdentityCandidate {
  name: string;
  plane?: Plane | string;
  serial?: string;
  claimedBy?: Plane[];
}

export interface DeviceIdentityResolution<T extends DeviceIdentityCandidate> {
  device: T | null;
  ambiguous: T[] | null;
  invalid: string | null;
}

/**
 * Compare two serials the way the rest of the portal decides whether two rows
 * are the same physical device.
 *
 * services/reconcile.ts's identityKey() keys a merged device on
 * `serial:${serial.trim().toLowerCase()}` — so trimming and case are already
 * settled as *not* part of a serial's identity, and two planes reporting
 * `SG12345` and `sg12345` are merged into one row. Comparing with `===` here
 * would disagree with that: an operator who supplies the serial in the casing
 * printed on the device label, rather than the casing whichever plane won the
 * merge happened to report, resolves to nothing at all.
 *
 * That failure is quiet in the worst way — the resolver returns
 * `{device: null, ambiguous: null, invalid: null}`, which callers render as
 * "device not found in inventory" for a device that is plainly in it.
 */
function sameSerial(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Resolve a device without ever choosing the first duplicate display name.
 * A supplied immutable identity must be a complete plane+serial pair.
 */
export function resolveDeviceIdentity<T extends DeviceIdentityCandidate>(
  devices: readonly T[],
  name: string,
  identity: DeviceIdentity,
  opts: { requireNameMatch?: boolean; requireCompleteIdentity?: boolean } = {},
): DeviceIdentityResolution<T> {
  const plane = identity.plane?.trim() || undefined;
  const serial = identity.serial?.trim() || undefined;
  if (opts.requireCompleteIdentity && ((plane && !serial) || (serial && !plane))) {
    return {
      device: null,
      ambiguous: null,
      invalid: 'plane and serial must be supplied together',
    };
  }
  if (plane && serial) {
    const device = devices.find((candidate) => candidate.plane === plane && sameSerial(candidate.serial, serial)) ?? null;
    if (device && opts.requireNameMatch && device.name !== name) {
      return {
        device: null,
        ambiguous: null,
        invalid: `device identity ${plane}/${serial} does not match route name '${name}'`,
      };
    }
    return { device, ambiguous: null, invalid: null };
  }
  if (serial) {
    const device = devices.find((candidate) => sameSerial(candidate.serial, serial)) ?? null;
    if (device && opts.requireNameMatch && device.name !== name) {
      return {
        device: null,
        ambiguous: null,
        invalid: `device serial '${serial}' does not match route name '${name}'`,
      };
    }
    return { device, ambiguous: null, invalid: null };
  }

  const matches = devices.filter((candidate) => candidate.name === name);
  if (matches.length <= 1) return { device: matches[0] ?? null, ambiguous: null, invalid: null };
  if (plane) {
    const byPlane = matches.filter(
      (candidate) => candidate.plane === plane || candidate.claimedBy?.includes(plane as Plane),
    );
    if (byPlane.length === 1) return { device: byPlane[0], ambiguous: null, invalid: null };
  }
  return { device: null, ambiguous: matches, invalid: null };
}

/**
 * Stable identity key for a complete plane+serial pair — the same pair
 * resolveDeviceIdentity treats as authoritative over a display name. Written
 * literally into a recording at open time (terminal.ts SessionRecorder) so a
 * future change to this format can never reinterpret an already-written
 * recording's identity; undefined when either half is missing, so a caller
 * never gets a key built from half an identity.
 */
export function deviceIdentityKey(plane?: string | null, serial?: string | null): string | undefined {
  const p = plane?.trim();
  const s = serial?.trim();
  if (!p || !s) return undefined;
  return `${p}/${s}`;
}

export function safeDeviceCandidates(
  matches: ReadonlyArray<Pick<DeviceIdentityCandidate, 'plane' | 'serial' | 'claimedBy'>>,
): Array<{ plane: string; serial: string | null; claimedBy: Plane[] }> {
  return matches.map((device) => ({
    plane: device.plane ?? 'UNKNOWN',
    serial: device.serial ?? null,
    claimedBy: device.claimedBy ?? (device.plane ? [device.plane as Plane] : []),
  }));
}
