/**
 * Tests for the plane-agnostic derivation helpers.
 *
 * These moved here from central.test.ts along with the code. Mist, UXI and
 * AOS-8 all rely on them, so a failure here is not a Central failure.
 */

import { describe, expect, it } from 'vitest';
import {
  ageString,
  durationString,
  externalSiteId,
  firmwareIsApproved,
  num,
  parseApprovedFirmware,
  parseTimestamp,
  sevFor,
  siteIdForName,
  str,
} from '../src/planes/format';

describe('pure helpers', () => {
  it('parseApprovedFirmware parses the comma map and skips junk', () => {
    expect(parseApprovedFirmware('cx=10.13,ap=10.6')).toEqual([
      ['cx', '10.13'],
      ['ap', '10.6'],
    ]);
    expect(parseApprovedFirmware('cx=10.13,,=bogus,noeq')).toEqual([['cx', '10.13']]);
    expect(parseApprovedFirmware(undefined)).toEqual([]);
  });

  it('firmwareIsApproved is honestly true without a declared train', () => {
    expect(firmwareIsApproved('switch', 'CX 6300M', '10.11.1030', [])).toBe(true);
    expect(firmwareIsApproved('switch', 'CX 6300M', '10.13.1005', [['cx', '10.13']])).toBe(true);
    expect(firmwareIsApproved('switch', 'CX 6300M', '10.11.1030', [['cx', '10.13']])).toBe(false);
    expect(firmwareIsApproved('ap', 'AP-635', '10.6.0.2', [['cx', '10.13']])).toBe(true); // family not covered
    expect(firmwareIsApproved('switch', 'CX 6300M', 'unknown', [['cx', '10.13']])).toBe(true);
  });

  it('externalSiteId slugs names outside the canonical union', () => {
    expect(externalSiteId('Zebra Kiosk')).toBe('ext-zebra-kiosk');
    expect(externalSiteId('HQ – East Wing!')).toBe('ext-hq-east-wing');
    expect(externalSiteId('   ')).toBe('ext-unknown');
  });

  it('siteIdForName canonicalises known aliases and keeps unknown display strings', () => {
    expect(siteIdForName('Campus-01 HQ')).toEqual({ siteId: 'campus-01', siteName: 'Campus-01 — Meridian HQ' });
    expect(siteIdForName('Zebra Kiosk')).toEqual({ siteId: 'ext-zebra-kiosk', siteName: 'Zebra Kiosk' });
    expect(siteIdForName(null)).toEqual({ siteId: 'multiple', siteName: 'Multiple' });
  });

  it('ageString / durationString / parseTimestamp / sevFor', () => {
    const now = 1_753_000_000_000;
    expect(ageString(now - 45_000, now)).toBe('45s');
    expect(ageString(now - 12 * 60_000, now)).toBe('12m');
    expect(ageString(now - 6 * 3_600_000, now)).toBe('6h');
    expect(ageString(now - 2 * 86_400_000, now)).toBe('2d');
    expect(durationString(14700)).toBe('4h 5m');
    expect(durationString(50)).toBe('50s');
    expect(parseTimestamp(1_753_000_000)).toBe(1_753_000_000_000); // epoch s → ms
    expect(parseTimestamp(1_753_000_000_000)).toBe(1_753_000_000_000);
    expect(parseTimestamp('2026-07-25T09:41:00Z')).toBe(Date.parse('2026-07-25T09:41:00Z'));
    expect(parseTimestamp('junk')).toBeNull();
    expect(sevFor('Critical')).toBe('P1');
    expect(sevFor('Warning')).toBe('P2');
    expect(sevFor('Informational')).toBe('P3');
  });
});

describe('field readers', () => {
  it('str trims, accepts finite numbers, and answers null for absent values', () => {
    expect(str('  ap-lobby-01 ')).toBe('ap-lobby-01');
    expect(str(42)).toBe('42');
    expect(str('')).toBeNull();
    expect(str('   ')).toBeNull();
    expect(str(null)).toBeNull();
    expect(str(undefined)).toBeNull();
    expect(str(Number.NaN)).toBeNull();
    expect(str({})).toBeNull();
  });

  it('num accepts numeric strings but never guesses a default', () => {
    expect(num(0)).toBe(0);
    expect(num('  17 ')).toBe(17);
    expect(num('-3.5')).toBe(-3.5);
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('distinguishes an omitted value from a zero — the reason both answer null', () => {
    // A Retry-After of 0 means "retry now"; an absent one means "no guidance".
    // Collapsing either to a default would make those indistinguishable.
    expect(num(0)).toBe(0);
    expect(num(undefined)).toBeNull();
  });
});
