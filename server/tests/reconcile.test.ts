/**
 * server/tests/reconcile.test.ts — cross-plane device reconciliation.
 *
 * Covers the design rules from README §"Integration model":
 *   rule 2 — reconcile, don't duplicate: identity by serial / normalized MAC /
 *     name; double-claim detection; local-only (unclaimed) rows first-class.
 *   rule 1 — never present stale data as current: rows whose only claimant is
 *     a stale plane read 'unverified'/neutral.
 */

import { describe, expect, it } from 'vitest';
import type { DeviceRow } from '@hpe/shared';
import type { PlaneId } from '../src/planes/types';
import {
  identityKey,
  normalizeMac,
  reconcileDevices,
  type DeviceIdentityHints,
} from '../src/services/reconcile';

type Row = DeviceRow & DeviceIdentityHints;

function row(over: Partial<Row> & { name: string }): Row {
  return {
    model: 'CX 6300M-48G',
    type: 'switch',
    siteId: 'campus-01',
    siteName: 'Campus-01 HQ',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'up',
    stateTone: 'success',
    firmware: '10.13.1005',
    firmwareApproved: true,
    licence: 'Foundation',
    reconciliationIssue: false,
    localShell: false,
    ...over,
  };
}

describe('identity', () => {
  it('normalizeMac strips separators and case', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aabbccddeeff');
    expect(normalizeMac('aabb.ccdd.eeff')).toBe('aabbccddeeff');
    expect(normalizeMac('AABB-CCDD-EEFF')).toBe('aabbccddeeff');
  });

  it('identityKey prefers serial, then MAC, then name', () => {
    expect(identityKey(row({ name: 'X', serial: ' SN1 ', mac: 'AA:BB:CC:DD:EE:FF' }))).toBe('serial:sn1');
    expect(identityKey(row({ name: 'X', mac: 'AA:BB:CC:DD:EE:FF' }))).toBe('mac:aabbccddeeff');
    expect(identityKey(row({ name: 'Sw-Core-A' }))).toBe('name:sw-core-a');
  });
});

describe('reconcileDevices', () => {
  it('merges rows from two planes that report the same serial (double-claim)', () => {
    const central = row({ name: 'sw-riv-2', serial: 'SN-1', firmware: '10.13.1005' });
    const classic = row({ name: 'sw-riv-2-old', serial: 'sn-1', plane: 'CLASSIC', planeTone: 'warning', firmware: '10.09.1010' });
    const { devices, doubleClaimed, unclaimed } = reconcileDevices({ central: [central], classic: [classic] });
    expect(devices).toHaveLength(1);
    expect(doubleClaimed).toBe(1);
    expect(unclaimed).toBe(0);
    expect(devices[0].claimedBy).toEqual(['CENTRAL', 'CLASSIC']);
    expect(devices[0].reconciliationIssue).toBe(true);
    // display fields prefer the higher-priority (central) row
    expect(devices[0].name).toBe('sw-riv-2');
    expect(devices[0].firmware).toBe('10.13.1005');
  });

  it('matches by normalized MAC across format variants', () => {
    const a = row({ name: 'ap-1f-04', mac: 'AA:BB:CC:DD:EE:FF', type: 'ap' });
    const b = row({ name: 'ap-1f-04', mac: 'aabb.ccdd.eeff', plane: 'MIST', planeTone: 'info', type: 'ap' });
    const { devices, doubleClaimed } = reconcileDevices({ central: [a], mist: [b] });
    expect(devices).toHaveLength(1);
    expect(doubleClaimed).toBe(1);
    expect(devices[0].claimedBy).toEqual(['CENTRAL', 'MIST']);
  });

  it('falls back to case-insensitive name matching when no hints exist', () => {
    const a = row({ name: 'mm-lake-1', type: 'controller', plane: 'AOS-8' });
    const b = row({ name: 'MM-LAKE-1', type: 'controller', plane: 'CENTRAL' });
    const { devices, doubleClaimed } = reconcileDevices({ aos8: [a], central: [b] });
    expect(devices).toHaveLength(1);
    expect(doubleClaimed).toBe(1);
    // central outranks aos8 for display fields
    expect(devices[0].plane).toBe('CENTRAL');
  });

  it('keeps genuinely different devices as separate rows', () => {
    const a = row({ name: 'ap-1', serial: 'SN-1', type: 'ap' });
    const b = row({ name: 'ap-2', serial: 'SN-2', type: 'ap' });
    const { devices, doubleClaimed, unclaimed } = reconcileDevices({ central: [a, b] });
    expect(devices).toHaveLength(2);
    expect(doubleClaimed).toBe(0);
    expect(unclaimed).toBe(0);
    expect(devices[0].reconciliationIssue).toBe(false);
  });

  it('local-only rows are first-class and counted unclaimed (in no management plane)', () => {
    const localOnly = row({ name: 'sw-core-a', plane: 'LOCAL', planeTone: 'neutral', localShell: true, licence: 'n/a — local' });
    const { devices, doubleClaimed, unclaimed } = reconcileDevices({ local: [localOnly] });
    expect(devices).toHaveLength(1);
    expect(unclaimed).toBe(1);
    expect(doubleClaimed).toBe(0);
    expect(devices[0].claimedBy).toEqual(['LOCAL']);
    expect(devices[0].reconciliationIssue).toBe(true); // flagged, but kept
    expect(devices[0].localShell).toBe(true);
  });

  it('a device claimed by local AND a cloud plane is double-claimed, not unclaimed', () => {
    const l = row({ name: 'sw-wh1-1', serial: 'SN-9', plane: 'LOCAL', planeTone: 'neutral' });
    const c = row({ name: 'sw-wh1-1', serial: 'SN-9' });
    const { devices, doubleClaimed, unclaimed } = reconcileDevices({ local: [l], central: [c] });
    expect(devices).toHaveLength(1);
    expect(doubleClaimed).toBe(1);
    expect(unclaimed).toBe(0);
    expect(devices[0].claimedBy).toEqual(['CENTRAL', 'LOCAL']);
  });

  it('stale-only claimant → state unverified + neutral tone (design rule 1)', () => {
    const staleRow = row({ name: 'sw-wh2-1', serial: 'SN-7', plane: 'CLASSIC', planeTone: 'warning', state: 'up', stateTone: 'success' });
    const { devices } = reconcileDevices({ classic: [staleRow] }, new Set<PlaneId>(['classic']));
    expect(devices).toHaveLength(1);
    expect(devices[0].state).toBe('unverified');
    expect(devices[0].stateTone).toBe('neutral');
  });

  it('a fresh claimant keeps the row verified and wins the display fields', () => {
    const staleClassic = row({ name: 'ap-riv-01', serial: 'SN-3', plane: 'CLASSIC', planeTone: 'warning', state: 'up', stateTone: 'success', firmware: '8.7.1.1' });
    const freshCentral = row({ name: 'ap-riv-01', serial: 'SN-3', state: 'down', stateTone: 'danger', firmware: '8.10.0.10' });
    const { devices } = reconcileDevices({ classic: [staleClassic], central: [freshCentral] }, new Set<PlaneId>(['classic']));
    expect(devices).toHaveLength(1);
    expect(devices[0].state).toBe('down'); // central's fresher, honest state wins
    expect(devices[0].stateTone).toBe('danger');
    expect(devices[0].firmware).toBe('8.10.0.10');
    expect(devices[0].claimedBy).toEqual(['CENTRAL', 'CLASSIC']);
  });

  it('priority order decides display fields among fresh claimants (classic > mist)', () => {
    const m = row({ name: 'ap-ng-02', serial: 'SN-4', plane: 'MIST', planeTone: 'info', firmware: '0.14.29' });
    const c = row({ name: 'ap-ng-02', serial: 'SN-4', plane: 'CLASSIC', planeTone: 'warning', firmware: '8.6.0.0' });
    const { devices } = reconcileDevices({ mist: [m], classic: [c] });
    expect(devices[0].firmware).toBe('8.6.0.0'); // classic display row
    expect(devices[0].claimedBy).toEqual(['CLASSIC', 'MIST']);
  });

  it('localShell is a union across claimants — a cloud row saying false does not erase a peer saying true', () => {
    // An AOS-8 controller (aos8 rows set localShell true for controllers) that
    // Central also claims. Central outranks aos8 for DISPLAY fields, but its
    // localShell:false means "Central provides no shell path", not "no shell
    // exists" — taking the display literal would lose the collector's session.
    const aos8 = row({ name: 'mm-lake-1', serial: 'SN-11', type: 'controller', plane: 'AOS-8', planeTone: 'accent', localShell: true, firmware: '8.10.0.10' });
    const central = row({ name: 'mm-lake-1', serial: 'SN-11', type: 'controller', localShell: false, firmware: '8.10.0.11' });
    const { devices } = reconcileDevices({ aos8: [aos8], central: [central] });
    expect(devices).toHaveLength(1);
    expect(devices[0].claimedBy).toEqual(['CENTRAL', 'AOS-8']);
    expect(devices[0].firmware).toBe('8.10.0.11'); // display fields still come from central
    expect(devices[0].localShell).toBe(true);
  });

  it('localShell stays false when no claimant reports a shell path', () => {
    // The union must not read as "double-claimed therefore shellable".
    const central = row({ name: 'ap-1f-04', serial: 'SN-12', type: 'ap', localShell: false });
    const mist = row({ name: 'ap-1f-04', serial: 'SN-12', type: 'ap', plane: 'MIST', planeTone: 'info', localShell: false });
    const { devices } = reconcileDevices({ central: [central], mist: [mist] });
    expect(devices).toHaveLength(1);
    expect(devices[0].localShell).toBe(false);
  });

  it('identity is strictly single-keyed: serial wins, so a name-only twin does NOT merge', () => {
    // Spec: "serial if present else normalized MAC else lowercased name" — a
    // plane that reports serials and a plane that only reports names produce
    // different keys for the same physical device and cannot be cross-matched.
    // Documented limitation, asserted so it never changes silently.
    const withSerial = row({ name: 'gw-edge-1', serial: 'SN-5', plane: 'CLASSIC', planeTone: 'warning', type: 'gateway' });
    const withoutSerial = row({ name: 'gw-edge-1', type: 'gateway' });
    const { devices, doubleClaimed } = reconcileDevices({ central: [withoutSerial], classic: [withSerial] });
    expect(devices).toHaveLength(2);
    expect(doubleClaimed).toBe(0);
  });

  it('empty input reconciles to empty output', () => {
    const { devices, doubleClaimed, unclaimed } = reconcileDevices({});
    expect(devices).toEqual([]);
    expect(doubleClaimed).toBe(0);
    expect(unclaimed).toBe(0);
  });
});
