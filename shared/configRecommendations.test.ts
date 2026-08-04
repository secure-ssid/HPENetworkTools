import { describe, expect, it } from 'vitest';
import {
  filterRecommendations,
  recommendationCounts,
  recommendationsForClient,
  recommendationsForDevice,
} from './configRecommendations';

describe('configRecommendations', () => {
  it('flags firmware target gaps only when unapproved', () => {
    const recs = recommendationsForDevice({
      name: 'ap-3f-14',
      type: 'ap',
      plane: 'MIST',
      firmware: '0.13.18',
      firmwareTarget: '0.14.29',
      firmwareApproved: false,
      site: 'Campus-02',
    });
    expect(recs.some((r) => r.ruleId === 'firmware.target-gap')).toBe(true);
  });

  it('does not invent firmware advice when target matches', () => {
    const recs = recommendationsForDevice({
      name: 'ap-ok',
      type: 'ap',
      plane: 'MIST',
      firmware: '0.14.29',
      firmwareTarget: '0.14.29',
      firmwareApproved: true,
    });
    expect(recs.filter((r) => r.category === 'firmware')).toHaveLength(0);
  });

  it('warns on reconciliation and down state', () => {
    const recs = recommendationsForDevice({
      name: 'sw-riv-2',
      type: 'switch',
      plane: 'CLASSIC',
      state: 'double-claimed',
      reconciliationIssue: true,
    });
    expect(recs.some((r) => r.ruleId === 'inventory.reconciliation')).toBe(true);
    expect(recs.some((r) => r.ruleId === 'inventory.double-claim')).toBe(true);
  });

  it('suggests client categorization and pending IP', () => {
    const recs = recommendationsForClient({
      name: 'unknown-phone',
      mac: 'aa:bb:cc:dd:ee:ff',
      type: 'unknown',
      plane: 'CENTRAL',
      ip: 'pending',
      problem: true,
    });
    expect(recs.some((r) => r.ruleId === 'client.uncategorized')).toBe(true);
    expect(recs.some((r) => r.ruleId === 'client.pending-ip')).toBe(true);
    expect(recs.some((r) => r.ruleId === 'client.problem')).toBe(true);
  });

  it('filters and counts', () => {
    const all = [
      ...recommendationsForDevice({
        name: 'a',
        type: 'ap',
        plane: 'MIST',
        firmware: '1',
        firmwareTarget: '2',
        firmwareApproved: false,
      }),
      ...recommendationsForClient({
        name: 'c',
        mac: '11:22:33:44:55:66',
        type: 'unknown',
        plane: 'MIST',
      }),
    ];
    const onlyFw = filterRecommendations(all, { category: 'firmware' });
    expect(onlyFw.every((r) => r.category === 'firmware')).toBe(true);
    expect(recommendationCounts(all).total).toBe(all.length);
  });
});
