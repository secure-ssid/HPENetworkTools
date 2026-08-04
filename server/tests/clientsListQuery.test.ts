/**
 * Loop 83 — pure unit tests for applyClientListFilters (no network).
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { applyClientListFilters } from '../src/routes/screens/clientsScreen';

function req(query: Record<string, string | undefined> = {}): Request {
  return { query } as unknown as Request;
}

describe('applyClientListFilters', () => {
  const body = {
    clients: [
      {
        name: 'laptop-a',
        mac: 'aa:bb:01',
        type: 'laptop',
        medium: 'wireless',
        siteName: 'Campus',
        group: 'corp',
        plane: 'CENTRAL',
        problem: false,
        health: 'good',
        model: 'MBP',
        attach: 'ap-1',
        where: 'wifi',
        ip: '10.0.0.1',
      },
      {
        name: 'phone-b',
        mac: 'aa:bb:02',
        type: 'phone',
        medium: 'wireless',
        siteName: 'Branch',
        group: 'guest',
        plane: 'MIST',
        problem: true,
        health: 'weak signal',
        model: 'iPhone',
        attach: 'ap-2',
        where: 'wifi',
        ip: '10.0.0.2',
        sources: [{ plane: 'CLEARPASS', row: { plane: 'CLEARPASS' } }],
      },
      {
        name: 'printer-c',
        mac: 'aa:bb:03',
        type: 'printer',
        medium: 'wired',
        siteName: 'Campus',
        group: 'corp',
        plane: 'CENTRAL',
        problem: false,
        health: 'good',
        model: 'HP',
        attach: 'sw-1',
        where: 'ge-0/0/1',
        ip: '10.0.0.3',
      },
    ],
  };

  it('filters by medium/type/site/group/problems/plane/health', () => {
    const medium = applyClientListFilters(req({ medium: 'wired' }), body);
    expect((medium.clients as { name: string }[]).map((c) => c.name)).toEqual(['printer-c']);

    const type = applyClientListFilters(req({ type: 'phone' }), body);
    expect((type.clients as { name: string }[]).map((c) => c.name)).toEqual(['phone-b']);

    const site = applyClientListFilters(req({ site: 'campus' }), body);
    expect((site.clients as { name: string }[]).map((c) => c.name).sort()).toEqual([
      'laptop-a',
      'printer-c',
    ]);

    const group = applyClientListFilters(req({ group: 'guest' }), body);
    expect((group.clients as { name: string }[]).map((c) => c.name)).toEqual(['phone-b']);

    const problems = applyClientListFilters(req({ problems: '1' }), body);
    expect((problems.clients as { name: string }[]).map((c) => c.name)).toEqual(['phone-b']);

    const plane = applyClientListFilters(req({ plane: 'clearpass' }), body);
    expect((plane.clients as { name: string }[]).map((c) => c.name)).toEqual(['phone-b']);

    const health = applyClientListFilters(req({ health: 'Weak Signal' }), body);
    expect((health.clients as { name: string }[]).map((c) => c.name)).toEqual(['phone-b']);

    const good = applyClientListFilters(req({ health: 'good' }), body);
    expect((good.clients as { name: string }[]).map((c) => c.name).sort()).toEqual([
      'laptop-a',
      'printer-c',
    ]);
  });

  it('ANDs q with medium and treats unknown problems/health as no-op or empty', () => {
    const q = applyClientListFilters(req({ q: 'printer', medium: 'wired' }), body);
    expect((q.clients as { name: string }[]).map((c) => c.name)).toEqual(['printer-c']);

    const unknown = applyClientListFilters(req({ problems: 'maybe' }), body);
    expect((unknown.clients as unknown[]).length).toBe(3);

    // Unknown health is an exact miss → empty (honest; not a silent no-op of all rows).
    const noHealth = applyClientListFilters(req({ health: 'imaginary' }), body);
    expect((noHealth.clients as unknown[]).length).toBe(0);
  });
});
