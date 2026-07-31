/**
 * server/tests/deviceIdentity.test.ts — the resolver every destructive device
 * action goes through, NO network.
 *
 * resolveDeviceIdentity() decides WHICH physical device a reboot, an SSH
 * session, a port config write or a device-detail read is aimed at. It had no
 * tests of its own despite being the last thing standing between a display
 * name and an action that power-cycles a box, so these pin each branch of it
 * directly rather than through a caller.
 *
 * The identity contract it implements is documented in two other places, and
 * the tests below deliberately reference both: services/reconcile.ts's
 * identityKey() (what makes two rows the same physical device) and
 * routes/screens.ts's serveDeviceDetail header (why a serial is allowed to
 * outrank a stale name in a deep link).
 */

import { describe, expect, it } from 'vitest';
import {
  deviceIdentityKey,
  resolveDeviceIdentity,
  safeDeviceCandidates,
  type DeviceIdentityCandidate,
} from '../src/services/deviceIdentity';
import { identityKey } from '../src/services/reconcile';
import type { DeviceRow } from '@hpe/shared';

const AP: DeviceIdentityCandidate = { name: 'ap-lobby-1', plane: 'CENTRAL', serial: 'SG12345XYZ' };
const SWITCH: DeviceIdentityCandidate = { name: 'sw-core-2', plane: 'CENTRAL', serial: 'CN99887766' };
/** Same display name as AP, different physical device — the case the resolver exists for. */
const AP_TWIN: DeviceIdentityCandidate = { name: 'ap-lobby-1', plane: 'MIST', serial: 'MS00011122' };

describe('resolveDeviceIdentity — complete plane+serial identity', () => {
  it('resolves the exact row and ignores a same-named device on another plane', () => {
    const r = resolveDeviceIdentity([AP, AP_TWIN], 'ap-lobby-1', { plane: 'MIST', serial: 'MS00011122' });
    expect(r.device).toBe(AP_TWIN);
    expect(r.ambiguous).toBeNull();
    expect(r.invalid).toBeNull();
  });

  it('rejects half an identity when the caller asks for a complete one', () => {
    const r = resolveDeviceIdentity([AP], 'ap-lobby-1', { plane: 'CENTRAL' }, { requireCompleteIdentity: true });
    expect(r.device).toBeNull();
    expect(r.invalid).toContain('plane and serial must be supplied together');
  });

  it('refuses a plane+serial that names a different device than the route asked for', () => {
    // The guard that stops POST /devices/ap-lobby-1/reboot with the core
    // switch's serial in the body from rebooting the core switch.
    const r = resolveDeviceIdentity(
      [AP, SWITCH],
      'ap-lobby-1',
      { plane: 'CENTRAL', serial: 'CN99887766' },
      { requireNameMatch: true },
    );
    expect(r.device).toBeNull();
    expect(r.invalid).toContain("does not match route name 'ap-lobby-1'");
  });

  it('returns a plain not-found (not an ambiguity) for an identity no row carries', () => {
    const r = resolveDeviceIdentity([AP], 'ap-lobby-1', { plane: 'CENTRAL', serial: 'NOSUCHSERIAL' });
    expect(r).toEqual({ device: null, ambiguous: null, invalid: null });
  });
});

/* reconcile.ts's identityKey() merges two planes' rows into ONE physical
 * device on `serial:${serial.trim().toLowerCase()}` — so trimming and case are
 * settled as not part of a serial's identity. The resolver used to compare
 * with `===`, which disagreed: an operator supplying the serial in the casing
 * printed on the device label instead of the casing whichever plane won the
 * merge reported got {device: null, ambiguous: null, invalid: null}, which
 * reboot.ts and writeBroker.ts both render as "device not found in inventory"
 * for a device that is plainly in it. */
describe('resolveDeviceIdentity — serial casing agrees with reconcile', () => {
  it('matches a serial whatever its case, on a complete identity', () => {
    const r = resolveDeviceIdentity(
      [{ name: 'ap-lobby-1', plane: 'CENTRAL', serial: 'sg12345xyz' }],
      'ap-lobby-1',
      { plane: 'CENTRAL', serial: 'SG12345XYZ' },
      { requireCompleteIdentity: true, requireNameMatch: true },
    );
    expect(r.device).not.toBeNull();
    expect(r.invalid).toBeNull();
  });

  it('matches a serial whatever its case on the serial-only path too', () => {
    const r = resolveDeviceIdentity([{ name: 'ap-lobby-1', serial: 'sg12345xyz' }], 'ap-lobby-1', {
      serial: '  SG12345XYZ  ',
    });
    expect(r.device).not.toBeNull();
  });

  it('agrees with reconcile.identityKey about what is one physical device', () => {
    // If these two rows key the same in reconcile, the resolver must find the
    // row from either spelling — otherwise the two modules disagree about
    // identity and the disagreement surfaces as a phantom 404.
    const row = (serial: string): DeviceRow => ({ name: 'ap-lobby-1', serial }) as DeviceRow;
    expect(identityKey(row('SG12345XYZ'))).toBe(identityKey(row('sg12345xyz')));
    for (const spelling of ['SG12345XYZ', 'sg12345xyz', 'Sg12345Xyz']) {
      const r = resolveDeviceIdentity([{ name: 'ap-lobby-1', serial: 'sg12345xyz' }], 'ap-lobby-1', {
        serial: spelling,
      });
      expect(r.device, `serial spelled ${spelling}`).not.toBeNull();
    }
  });

  it('still refuses a serial that genuinely belongs to no row', () => {
    // Case-insensitivity must not become substring or prefix matching.
    const r = resolveDeviceIdentity([{ name: 'ap-lobby-1', serial: 'sg12345xyz' }], 'ap-lobby-1', {
      serial: 'sg12345',
    });
    expect(r.device).toBeNull();
  });
});

describe('resolveDeviceIdentity — name-only resolution never guesses', () => {
  it('resolves a unique name', () => {
    expect(resolveDeviceIdentity([AP, SWITCH], 'sw-core-2', {}).device).toBe(SWITCH);
  });

  it('reports EVERY match for a duplicated name instead of picking the first', () => {
    const r = resolveDeviceIdentity([AP, AP_TWIN], 'ap-lobby-1', {});
    expect(r.device).toBeNull();
    expect(r.ambiguous).toEqual([AP, AP_TWIN]);
  });

  it('narrows a duplicated name by plane when that alone is unambiguous', () => {
    const r = resolveDeviceIdentity([AP, AP_TWIN], 'ap-lobby-1', { plane: 'MIST' });
    expect(r.device).toBe(AP_TWIN);
    expect(r.ambiguous).toBeNull();
  });

  it('narrows by a claimedBy plane, not just the owning plane', () => {
    const claimed: DeviceIdentityCandidate = { name: 'ap-lobby-1', plane: 'CENTRAL', serial: 'AA1', claimedBy: ['UXI'] };
    const other: DeviceIdentityCandidate = { name: 'ap-lobby-1', plane: 'MIST', serial: 'BB2' };
    expect(resolveDeviceIdentity([claimed, other], 'ap-lobby-1', { plane: 'UXI' }).device).toBe(claimed);
  });

  it('stays ambiguous when the plane hint narrows to more than one row', () => {
    const a: DeviceIdentityCandidate = { name: 'ap-lobby-1', plane: 'CENTRAL', serial: 'AA1' };
    const b: DeviceIdentityCandidate = { name: 'ap-lobby-1', plane: 'CENTRAL', serial: 'BB2' };
    const r = resolveDeviceIdentity([a, b], 'ap-lobby-1', { plane: 'CENTRAL' });
    expect(r.device).toBeNull();
    expect(r.ambiguous).toEqual([a, b]);
  });

  it('returns nothing for an unknown name without inventing an ambiguity', () => {
    expect(resolveDeviceIdentity([AP], 'nope', {})).toEqual({ device: null, ambiguous: null, invalid: null });
  });

  it('treats a whitespace-only plane or serial as absent, not as a filter', () => {
    const r = resolveDeviceIdentity([AP, AP_TWIN], 'ap-lobby-1', { plane: '   ', serial: '   ' });
    expect(r.ambiguous).toEqual([AP, AP_TWIN]);
    expect(r.invalid).toBeNull();
  });
});

describe('deviceIdentityKey', () => {
  it('needs both halves — never builds a key from half an identity', () => {
    expect(deviceIdentityKey('CENTRAL', 'SG1')).toBe('CENTRAL/SG1');
    expect(deviceIdentityKey('CENTRAL', undefined)).toBeUndefined();
    expect(deviceIdentityKey(undefined, 'SG1')).toBeUndefined();
    expect(deviceIdentityKey('CENTRAL', '   ')).toBeUndefined();
    expect(deviceIdentityKey(null, null)).toBeUndefined();
  });

  it('preserves serial casing verbatim', () => {
    // Deliberately NOT normalised like the resolver's comparison: this string
    // is written literally into a terminal recording at open time, so
    // lowercasing it here would silently reinterpret the identity of every
    // recording already on disk.
    expect(deviceIdentityKey('CENTRAL', 'Sg12345Xyz')).toBe('CENTRAL/Sg12345Xyz');
  });
});

describe('safeDeviceCandidates', () => {
  it('names an unknown plane rather than dropping the row or emitting undefined', () => {
    expect(safeDeviceCandidates([{ plane: undefined, serial: undefined, claimedBy: undefined }])).toEqual([
      { plane: 'UNKNOWN', serial: null, claimedBy: [] },
    ]);
  });

  it('keeps a missing serial distinguishable as null, not as an empty string', () => {
    const [row] = safeDeviceCandidates([{ plane: 'CENTRAL', serial: undefined }]);
    expect(row.serial).toBeNull();
    expect(row.claimedBy).toEqual(['CENTRAL']);
  });

  it('preserves an explicit claimedBy list', () => {
    const [row] = safeDeviceCandidates([{ plane: 'CENTRAL', serial: 'SG1', claimedBy: ['CENTRAL', 'UXI'] }]);
    expect(row.claimedBy).toEqual(['CENTRAL', 'UXI']);
  });
});
