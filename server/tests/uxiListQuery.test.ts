/**
 * Loop 61 / 110 / 118 — UXI sensor status/site/severity filter helper (no network).
 * Loop 118: shared queryString / queryOneOf parsers.
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { applyUxiSensorFilters } from '../src/routes/screens/uxiScreen';

function req(query: Record<string, string | undefined> = {}): Request {
  return { query } as unknown as Request;
}

describe('applyUxiSensorFilters', () => {
  const body = {
    sensors: [
      { id: '1', name: 'a', site: 'Campus A', isOnline: true, isTesting: true, issueCount: 0, issues: [] },
      {
        id: '2',
        name: 'b',
        site: 'DC West',
        isOnline: false,
        isTesting: false,
        issueCount: 2,
        issues: [
          { severity: 'warning' },
          { severity: 'critical' },
        ],
      },
      { id: '3', name: 'c', site: 'Campus A', isOnline: true, isTesting: false, issueCount: 0, issues: [] },
      { id: '4', name: 'd', site: null, isOnline: null, isTesting: null, issueCount: 0, issues: [] },
      {
        id: '5',
        name: 'e',
        site: 'Campus A',
        isOnline: true,
        isTesting: true,
        issueCount: 1,
        issues: [{ severity: 'info' }],
      },
    ],
  };

  it('filters by status=offline and status=issues', () => {
    const offline = applyUxiSensorFilters(req({ status: 'offline' }), body);
    expect((offline.sensors as { id: string }[]).map((s) => s.id)).toEqual(['2']);

    const issues = applyUxiSensorFilters(req({ status: 'issues' }), body);
    expect((issues.sensors as { id: string }[]).map((s) => s.id)).toEqual(['2', '5']);
  });

  it('filters by exact site (case-insensitive) and idle online', () => {
    const site = applyUxiSensorFilters(req({ site: 'campus a' }), body);
    expect((site.sensors as { id: string }[]).map((s) => s.id)).toEqual(['1', '3', '5']);

    const idle = applyUxiSensorFilters(req({ status: 'idle' }), body);
    expect((idle.sensors as { id: string }[]).map((s) => s.id)).toEqual(['3']);
  });

  it('filters by issue severity (Loop 110)', () => {
    const critical = applyUxiSensorFilters(req({ severity: 'critical' }), body);
    expect((critical.sensors as { id: string }[]).map((s) => s.id)).toEqual(['2']);

    const warning = applyUxiSensorFilters(req({ severity: 'WARNING' }), body);
    expect((warning.sensors as { id: string }[]).map((s) => s.id)).toEqual(['2']);

    const info = applyUxiSensorFilters(req({ severity: 'info' }), body);
    expect((info.sensors as { id: string }[]).map((s) => s.id)).toEqual(['5']);
  });

  it('ignores unknown status/severity values (no invented empty list)', () => {
    const out = applyUxiSensorFilters(req({ status: 'not-a-real-status' }), body);
    expect((out.sensors as unknown[]).length).toBe(5);

    const sev = applyUxiSensorFilters(req({ severity: 'fatal' }), body);
    expect((sev.sensors as unknown[]).length).toBe(5);
  });

  it('trims site and matches status case-insensitively via shared helpers (Loop 118)', () => {
    const site = applyUxiSensorFilters(req({ site: '  Campus A  ' }), body);
    expect((site.sensors as { id: string }[]).map((s) => s.id)).toEqual(['1', '3', '5']);

    const status = applyUxiSensorFilters(req({ status: 'OFFLINE' }), body);
    expect((status.sensors as { id: string }[]).map((s) => s.id)).toEqual(['2']);

    const severity = applyUxiSensorFilters(req({ severity: ' Critical ' }), body);
    expect((severity.sensors as { id: string }[]).map((s) => s.id)).toEqual(['2']);
  });
});
