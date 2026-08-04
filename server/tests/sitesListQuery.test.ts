/**
 * Loop 81 / 116 — pure unit tests for applySiteListFilters (no network).
 * Loop 116: shared queryString / queryOneOf parsers.
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { applySiteListFilters } from '../src/routes/screens/sitesScreen';

function req(query: Record<string, string | undefined> = {}): Request {
  return { query } as unknown as Request;
}

describe('applySiteListFilters', () => {
  const body = {
    sites: [
      {
        id: 'a',
        name: 'Campus HQ',
        subnet: '10.0.0.0/16',
        mix: 'ap',
        sync: '40s',
        tone: 'ok',
        planes: [{ name: 'CENTRAL' }, { name: 'LOCAL' }],
      },
      {
        id: 'b',
        name: 'Branch Mist',
        subnet: '10.1.0.0/24',
        mix: 'ap',
        sync: '1m',
        tone: 'warn',
        planes: [{ name: 'MIST' }],
      },
      {
        id: 'c',
        name: 'Stale Edge',
        subnet: '10.2.0.0/24',
        mix: 'sw',
        sync: '6h',
        tone: 'stale',
        planes: ['CLASSIC'],
      },
    ],
  };

  it('filters by health tone and plane badge name (case-insensitive)', () => {
    const health = applySiteListFilters(req({ health: 'warn' }), body);
    expect((health.sites as { id: string }[]).map((s) => s.id)).toEqual(['b']);

    const plane = applySiteListFilters(req({ plane: 'central' }), body);
    expect((plane.sites as { id: string }[]).map((s) => s.id)).toEqual(['a']);

    const classic = applySiteListFilters(req({ plane: 'classic' }), body);
    expect((classic.sites as { id: string }[]).map((s) => s.id)).toEqual(['c']);
  });

  it('ANDs q with health/plane and ignores unknown health', () => {
    const q = applySiteListFilters(req({ q: 'branch', health: 'warn' }), body);
    expect((q.sites as { id: string }[]).map((s) => s.id)).toEqual(['b']);

    const unknown = applySiteListFilters(req({ health: 'critical' }), body);
    expect((unknown.sites as unknown[]).length).toBe(3);
  });

  it('honours queryOneOf health case-insensitively and trims q (Loop 116)', () => {
    const health = applySiteListFilters(req({ health: '  WARN  ' }), body);
    expect((health.sites as { id: string }[]).map((s) => s.id)).toEqual(['b']);

    const q = applySiteListFilters(req({ q: '  Campus  ' }), body);
    expect((q.sites as { id: string }[]).map((s) => s.id)).toEqual(['a']);

    // Non-string query bags are honest no-ops via shared parsers.
    const junk = applySiteListFilters(
      { query: { health: ['ok'], q: 12 } } as unknown as Request,
      body,
    );
    expect((junk.sites as unknown[]).length).toBe(3);
  });
});
