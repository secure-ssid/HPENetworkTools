/**
 * Loop 84 — shared export `?part=` / section contracts stay aligned with
 * route parsers (topology, licences, GreenLake, ClearPass, overview, Central).
 */
import { describe, expect, it } from 'vitest';
import {
  CENTRAL_EXPORT_PARTS,
  CENTRAL_EXPORT_SECTIONS,
  CLEARPASS_EXPORT_PARTS,
  CONFIGURE_EXPORT_PARTS,
  DEVICE_TRENDS_EXPORT_PARTS,
  GREENLAKE_EXPORT_PARTS,
  LICENSES_EXPORT_PARTS,
  METRICS_EXPORT_PARTS,
  MIST_EXPORT_PARTS,
  OVERVIEW_EXPORT_PARTS,
  TOPOLOGY_EXPORT_PARTS,
} from '@hpe/shared';

describe('shared export part catalogs', () => {
  it('topology parts are nodes|edges only', () => {
    expect([...TOPOLOGY_EXPORT_PARTS]).toEqual(['nodes', 'edges']);
  });

  it('licenses parts are subscriptions|renewals only', () => {
    expect([...LICENSES_EXPORT_PARTS]).toEqual(['subscriptions', 'renewals']);
  });

  it('greenlake parts are users|locations|roles only', () => {
    expect([...GREENLAKE_EXPORT_PARTS]).toEqual(['users', 'locations', 'roles']);
  });

  it('clearpass parts are endpoints|sessions|services (omit = endpoints+sessions)', () => {
    expect([...CLEARPASS_EXPORT_PARTS]).toEqual(['endpoints', 'sessions', 'services']);
  });

  it('configure parts are ssids|ports|vlans (Loop 95)', () => {
    expect([...CONFIGURE_EXPORT_PARTS]).toEqual(['ssids', 'ports', 'vlans']);
  });

  it('overview parts are alerts|planes|sites|changes (Loop 89)', () => {
    expect([...OVERVIEW_EXPORT_PARTS]).toEqual(['alerts', 'planes', 'sites', 'changes']);
  });

  it('central section column values are device|site', () => {
    expect([...CENTRAL_EXPORT_SECTIONS]).toEqual(['device', 'site']);
  });

  it('central export parts include firmware|wlans|alerts (Loop 102/103)', () => {
    expect([...CENTRAL_EXPORT_PARTS]).toEqual(['device', 'site', 'firmware', 'wlans', 'alerts']);
    for (const s of CENTRAL_EXPORT_SECTIONS) {
      expect(CENTRAL_EXPORT_PARTS).toContain(s);
    }
  });

  it('mist parts are devices|rogues|ap-stats|sle (Loop 98)', () => {
    expect([...MIST_EXPORT_PARTS]).toEqual([
      'devices',
      'rogues',
      'ap-stats',
      'sle',
      'wlans',
      'licenses',
    ]);
  });

  it('device trends parts are hardware|interfaces|ap (Loop 98)', () => {
    expect([...DEVICE_TRENDS_EXPORT_PARTS]).toEqual(['hardware', 'interfaces', 'ap']);
  });

  it('metrics parts are series|anomalies (Loop 101)', () => {
    expect([...METRICS_EXPORT_PARTS]).toEqual(['series', 'anomalies']);
  });

  it('every catalog is unique and non-empty', () => {
    const catalogs = [
      TOPOLOGY_EXPORT_PARTS,
      LICENSES_EXPORT_PARTS,
      GREENLAKE_EXPORT_PARTS,
      CLEARPASS_EXPORT_PARTS,
      CONFIGURE_EXPORT_PARTS,
      OVERVIEW_EXPORT_PARTS,
      CENTRAL_EXPORT_SECTIONS,
      CENTRAL_EXPORT_PARTS,
      MIST_EXPORT_PARTS,
      DEVICE_TRENDS_EXPORT_PARTS,
      METRICS_EXPORT_PARTS,
    ];
    for (const c of catalogs) {
      expect(c.length).toBeGreaterThan(0);
      expect(new Set(c).size).toBe(c.length);
      for (const part of c) {
        expect(part.trim()).toBe(part);
        expect(part.length).toBeGreaterThan(0);
      }
    }
  });
});
