/**
 * Loop 83 — pure unit tests for applyDeviceListFilters (no network).
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { applyDeviceListFilters } from '../src/routes/screens/devicesScreen';

function req(query: Record<string, string | undefined> = {}): Request {
  return { query } as unknown as Request;
}

describe('applyDeviceListFilters', () => {
  const body = {
    devices: [
      {
        name: 'sw-core-a',
        type: 'switch',
        plane: 'CENTRAL',
        siteId: 'campus',
        siteName: 'Campus HQ',
        state: 'up',
        reconciliationIssue: false,
        serial: 'SN-A',
        model: '6300',
      },
      {
        name: 'ap-lobby',
        type: 'ap',
        plane: 'MIST',
        siteId: 'branch',
        siteName: 'Branch Mist',
        state: 'down',
        reconciliationIssue: true,
        claimedBy: ['MIST', 'CENTRAL'],
        serial: 'SN-B',
        model: 'AP43',
      },
      {
        name: 'gw-edge',
        type: 'gateway',
        plane: 'CLASSIC',
        siteId: 'edge',
        siteName: 'Edge',
        state: 'up',
        reconciliationIssue: false,
        serial: 'SN-C',
        model: '9004',
      },
    ],
  };

  it('filters by type, issues, and multi plane/site/state', () => {
    const type = applyDeviceListFilters(req({ type: 'ap' }), body);
    expect((type.devices as { name: string }[]).map((d) => d.name)).toEqual(['ap-lobby']);

    const issues = applyDeviceListFilters(req({ issues: '1' }), body);
    expect((issues.devices as { name: string }[]).map((d) => d.name)).toEqual(['ap-lobby']);

    const plane = applyDeviceListFilters(req({ plane: 'central' }), body);
    expect((plane.devices as { name: string }[]).map((d) => d.name).sort()).toEqual([
      'ap-lobby',
      'sw-core-a',
    ]);

    const site = applyDeviceListFilters(req({ site: 'branch,campus' }), body);
    expect((site.devices as { name: string }[]).map((d) => d.name).sort()).toEqual([
      'ap-lobby',
      'sw-core-a',
    ]);

    const state = applyDeviceListFilters(req({ state: 'down' }), body);
    expect((state.devices as { name: string }[]).map((d) => d.name)).toEqual(['ap-lobby']);
  });

  it('ANDs q with type and ignores empty issues', () => {
    const q = applyDeviceListFilters(req({ q: 'lobby', type: 'ap' }), body);
    expect((q.devices as { name: string }[]).map((d) => d.name)).toEqual(['ap-lobby']);

    const none = applyDeviceListFilters(req({ issues: 'maybe' }), body);
    expect((none.devices as unknown[]).length).toBe(3);

    // Loop 113: shared queryFlag accepts yes/on; queryTokens dedupes multi plane.
    const yes = applyDeviceListFilters(req({ issues: 'yes' }), body);
    expect((yes.devices as { name: string }[]).map((d) => d.name)).toEqual(['ap-lobby']);

    const multi = applyDeviceListFilters(req({ plane: 'CENTRAL, central,MIST' }), body);
    expect((multi.devices as { name: string }[]).map((d) => d.name).sort()).toEqual([
      'ap-lobby',
      'sw-core-a',
    ]);
  });
});
